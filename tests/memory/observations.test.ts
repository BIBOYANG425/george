import { describe, it, expect, vi } from 'vitest';

// createSupabaseObservationDB builds a real service-role client; @supabase/supabase-js
// validates the URL at construction (no network). Match the repo idiom.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import {
  createObservationDB,
  createSupabaseObservationDB,
  embedObservation,
} from '../../src/memory/observations.js';

const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ── A thin chainable Supabase stub ─────────────────────────────────────────
// Records the call chain so tests can assert argument shaping. Each terminal
// op (insert/update/delete/select/order/limit/is/gte/eq/lt/or/rpc) resolves to
// the configured { data, error, count }.
function makeFakeClient(result: { data?: any; error?: any; count?: number } = {}) {
  const res = { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
  const calls: { method: string; args: any[] }[] = [];
  let lastTable: string | null = null;
  let rpcCall: { name: string; params: any } | null = null;
  let insertArg: any = undefined;
  let updateArg: any = undefined;
  let deleteOpts: any = undefined;

  // The builder is a thenable so `await builder` resolves to res, while every
  // chain method returns the same builder for fluent chaining.
  const builder: any = {
    insert(arg: any) { insertArg = arg; calls.push({ method: 'insert', args: [arg] }); return builder; },
    update(arg: any) { updateArg = arg; calls.push({ method: 'update', args: [arg] }); return builder; },
    delete(opts: any) { deleteOpts = opts; calls.push({ method: 'delete', args: [opts] }); return builder; },
    select(...args: any[]) { calls.push({ method: 'select', args }); return builder; },
    eq(...args: any[]) { calls.push({ method: 'eq', args }); return builder; },
    lt(...args: any[]) { calls.push({ method: 'lt', args }); return builder; },
    gte(...args: any[]) { calls.push({ method: 'gte', args }); return builder; },
    is(...args: any[]) { calls.push({ method: 'is', args }); return builder; },
    in(...args: any[]) { calls.push({ method: 'in', args }); return builder; },
    or(...args: any[]) { calls.push({ method: 'or', args }); return builder; },
    order(...args: any[]) { calls.push({ method: 'order', args }); return builder; },
    limit(...args: any[]) { calls.push({ method: 'limit', args }); return builder; },
    then(resolve: any) { return Promise.resolve(res).then(resolve); },
  };

  const client: any = {
    from(table: string) { lastTable = table; calls.push({ method: 'from', args: [table] }); return builder; },
    rpc(name: string, params: any) {
      rpcCall = { name, params };
      calls.push({ method: 'rpc', args: [name, params] });
      return Promise.resolve(res);
    },
    functions: { invoke: vi.fn() },
  };

  return {
    client,
    calls,
    get table() { return lastTable; },
    get rpcCall() { return rpcCall; },
    get insertArg() { return insertArg; },
    get updateArg() { return updateArg; },
    get deleteOpts() { return deleteOpts; },
    callWith(method: string) { return calls.find((c) => c.method === method); },
  };
}

describe('createSupabaseObservationDB', () => {
  it('builds an object exposing all 6 ObservationDB methods', () => {
    const db = createSupabaseObservationDB();
    for (const m of ['insert', 'recall', 'loadUnconsolidated', 'markConsolidated', 'prune', 'deleteForUser']) {
      expect(typeof (db as any)[m]).toBe('function');
    }
  });
});

describe('ObservationDB.insert', () => {
  it('inserts into user_observations with the right shape', async () => {
    const fake = makeFakeClient({ error: null });
    const db = createObservationDB(fake.client);
    await db.insert(UID, { content: 'sleeps at 3am', salience: 4, kind: 'habit' }, [0.1, 0.2]);
    expect(fake.table).toBe('user_observations');
    expect(fake.insertArg).toEqual({
      user_id: UID,
      content: 'sleeps at 3am',
      embedding: [0.1, 0.2],
      salience: 4,
      kind: 'habit',
    });
  });

  it('defaults kind to null when omitted', async () => {
    const fake = makeFakeClient({ error: null });
    const db = createObservationDB(fake.client);
    await db.insert(UID, { content: 'x', salience: 2 }, null);
    expect(fake.insertArg.kind).toBeNull();
    expect(fake.insertArg.embedding).toBeNull();
  });

  it('throws on insert error', async () => {
    const fake = makeFakeClient({ error: { message: 'boom' } });
    const db = createObservationDB(fake.client);
    await expect(db.insert(UID, { content: 'x', salience: 1 }, null)).rejects.toThrow(/boom/);
  });
});

describe('ObservationDB.recall', () => {
  it('calls recall_observations RPC with expected params and returns data', async () => {
    const rows = [
      { id: 1, content: 'a', salience: 5, kind: 'habit', created_at: 't', score: 0.9 },
    ];
    const fake = makeFakeClient({ data: rows, error: null });
    const db = createObservationDB(fake.client);
    const out = await db.recall(UID, [0.1, 0.2], 8, 2, 14);
    expect(fake.rpcCall).toEqual({
      name: 'recall_observations',
      params: {
        p_user_id: UID,
        p_query_embedding: [0.1, 0.2],
        p_match_count: 8,
        p_min_salience: 2,
        p_half_life_days: 14,
      },
    });
    expect(out).toEqual(rows);
  });

  it('returns [] when data is null', async () => {
    const fake = makeFakeClient({ data: null, error: null });
    const db = createObservationDB(fake.client);
    expect(await db.recall(UID, [0], 1, 1, 14)).toEqual([]);
  });

  it('throws on recall error', async () => {
    const fake = makeFakeClient({ error: { message: 'rpc fail' } });
    const db = createObservationDB(fake.client);
    await expect(db.recall(UID, [0], 1, 1, 14)).rejects.toThrow(/rpc fail/);
  });
});

describe('ObservationDB.loadUnconsolidated', () => {
  it('selects unconsolidated rows above salience, ordered + limited', async () => {
    const rows = [{ id: 3, content: 'c', salience: 4, kind: null, created_at: 't' }];
    const fake = makeFakeClient({ data: rows, error: null });
    const db = createObservationDB(fake.client);
    const out = await db.loadUnconsolidated(UID, 3, 20);
    expect(fake.table).toBe('user_observations');
    expect(fake.callWith('select')!.args[0]).toBe('id, content, salience, kind, created_at');
    expect(fake.callWith('eq')!.args).toEqual(['user_id', UID]);
    expect(fake.callWith('is')!.args).toEqual(['consolidated_at', null]);
    expect(fake.callWith('gte')!.args).toEqual(['salience', 3]);
    expect(fake.callWith('order')!.args).toEqual(['created_at', { ascending: false }]);
    expect(fake.callWith('limit')!.args).toEqual([20]);
    expect(out).toEqual(rows);
  });

  it('returns [] when data null and throws on error', async () => {
    const ok = makeFakeClient({ data: null, error: null });
    expect(await createObservationDB(ok.client).loadUnconsolidated(UID, 1, 1)).toEqual([]);
    const bad = makeFakeClient({ error: { message: 'load fail' } });
    await expect(createObservationDB(bad.client).loadUnconsolidated(UID, 1, 1)).rejects.toThrow(/load fail/);
  });
});

describe('ObservationDB.markConsolidated', () => {
  it('no-ops on empty ids', async () => {
    const fake = makeFakeClient({ error: null });
    const db = createObservationDB(fake.client);
    await db.markConsolidated([]);
    expect(fake.calls.length).toBe(0);
  });

  it('updates consolidated_at for the given ids', async () => {
    const fake = makeFakeClient({ error: null });
    const db = createObservationDB(fake.client);
    await db.markConsolidated([1, 2, 3]);
    expect(fake.table).toBe('user_observations');
    expect(typeof fake.updateArg.consolidated_at).toBe('string');
    expect(fake.callWith('in')!.args).toEqual(['id', [1, 2, 3]]);
  });

  it('throws on error', async () => {
    const fake = makeFakeClient({ error: { message: 'mark fail' } });
    const db = createObservationDB(fake.client);
    await expect(db.markConsolidated([1])).rejects.toThrow(/mark fail/);
  });
});

describe('ObservationDB.prune', () => {
  it('deletes stale rows with exact count and returns the count', async () => {
    const fake = makeFakeClient({ error: null, count: 7 });
    const db = createObservationDB(fake.client);
    const n = await db.prune(UID, 30);
    expect(fake.table).toBe('user_observations');
    expect(fake.deleteOpts).toEqual({ count: 'exact' });
    expect(fake.callWith('eq')!.args).toEqual(['user_id', UID]);
    expect(fake.callWith('or')!.args).toEqual(['consolidated_at.not.is.null,salience.lte.1']);
    // cutoff is an ISO timestamp on created_at via lt()
    const ltCall = fake.callWith('lt')!;
    expect(ltCall.args[0]).toBe('created_at');
    expect(typeof ltCall.args[1]).toBe('string');
    expect(n).toBe(7);
  });

  it('returns 0 when count is null', async () => {
    const fake = makeFakeClient({ error: null, count: null });
    expect(await createObservationDB(fake.client).prune(UID, 1)).toBe(0);
  });

  it('throws on error', async () => {
    const fake = makeFakeClient({ error: { message: 'prune fail' } });
    await expect(createObservationDB(fake.client).prune(UID, 1)).rejects.toThrow(/prune fail/);
  });
});

describe('ObservationDB.deleteForUser', () => {
  it('deletes all rows for a user', async () => {
    const fake = makeFakeClient({ error: null });
    const db = createObservationDB(fake.client);
    await db.deleteForUser(UID);
    expect(fake.table).toBe('user_observations');
    expect(fake.callWith('delete')).toBeDefined();
    expect(fake.callWith('eq')!.args).toEqual(['user_id', UID]);
  });

  it('throws on error', async () => {
    const fake = makeFakeClient({ error: { message: 'del fail' } });
    await expect(createObservationDB(fake.client).deleteForUser(UID)).rejects.toThrow(/del fail/);
  });
});

describe('embedObservation', () => {
  it('returns the embedding array when invoke succeeds', async () => {
    const client: any = {
      functions: { invoke: vi.fn(async () => ({ data: { embeddings: [[0.1, 0.2, 0.3]] }, error: null })) },
    };
    const out = await embedObservation('hello', client);
    expect(out).toEqual([0.1, 0.2, 0.3]);
    expect(client.functions.invoke).toHaveBeenCalledWith('embed', { body: { texts: ['hello'] } });
  });

  it('returns null when invoke returns an error', async () => {
    const client: any = {
      functions: { invoke: vi.fn(async () => ({ data: null, error: { message: 'no embed' } })) },
    };
    expect(await embedObservation('hello', client)).toBeNull();
  });

  it('returns null when invoke throws', async () => {
    const client: any = {
      functions: { invoke: vi.fn(async () => { throw new Error('network'); }) },
    };
    expect(await embedObservation('hello', client)).toBeNull();
  });

  it('returns null when embeddings[0] is not an array', async () => {
    const client: any = {
      functions: { invoke: vi.fn(async () => ({ data: { embeddings: ['not-an-array'] }, error: null })) },
    };
    expect(await embedObservation('hello', client)).toBeNull();
  });
});
