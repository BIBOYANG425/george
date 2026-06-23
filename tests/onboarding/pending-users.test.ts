// tests/onboarding/pending-users.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createPendingUser,
  lookupByCode,
  lookupByImessageHandle,
  markReminded,
  cleanupOld,
} from '../../src/onboarding/pending-users.js';

function mockSupabase() {
  const rows: any[] = [];
  return {
    rows,
    from(table: string) {
      return {
        insert: vi.fn(async (row: any) => { rows.push({ ...row, table }); return { error: null }; }),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({ data: rows.find(r => r.table === table) ?? null, error: null })),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      } as any;
    },
  };
}

// Records every method call in the query chain so filter assertions can be
// made without a real Postgrest client. The chain resolves like a thenable
// with the supplied terminal result.
function recordingSupabase(result: { data: any; error: any }) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: any) => void) => resolve(result);
        }
        return (...args: any[]) => {
          calls.push({ method: prop, args });
          return chain;
        };
      },
    },
  );
  return { calls, client: { from: () => chain } as any };
}

describe('createPendingUser', () => {
  it('inserts a new pending_users row', async () => {
    const supabase = mockSupabase();
    await createPendingUser(supabase as any, 'g7k2m4');
    expect(supabase.rows[0]).toMatchObject({ code: 'g7k2m4', status: 'pending' });
  });
});

describe('lookupByCode', () => {
  it('returns null for missing code', async () => {
    const supabase = mockSupabase();
    const result = await lookupByCode(supabase as any, 'nope12');
    expect(result).toBeNull();
  });
});

describe('lookupByImessageHandle', () => {
  it('takes the newest pending row instead of erroring on multiple matches', async () => {
    // A user who minted two codes and handshook both has two pending rows
    // with the same handle. maybeSingle() would throw here; the limit(1)
    // shape must return the newest row.
    const newest = { code: 'newer1', imessage_handle: '+1555', status: 'pending' };
    const { calls, client } = recordingSupabase({ data: [newest], error: null });
    const result = await lookupByImessageHandle(client, '+1555');
    expect(result).toEqual(newest);
    expect(calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    expect(calls).toContainEqual({ method: 'limit', args: [1] });
    expect(calls.map(c => c.method)).not.toContain('maybeSingle');
  });

  it('returns null when no row matches', async () => {
    const { client } = recordingSupabase({ data: [], error: null });
    expect(await lookupByImessageHandle(client, '+1555')).toBeNull();
  });
});

describe('markReminded', () => {
  it('sets reminded_at scoped to the given code', async () => {
    const { calls, client } = recordingSupabase({ data: null, error: null });
    await markReminded(client, 'g7k2m4');
    // Updates reminded_at to a timestamp...
    const update = calls.find(c => c.method === 'update');
    expect(update).toBeTruthy();
    expect(update!.args[0]).toHaveProperty('reminded_at');
    expect(typeof update!.args[0].reminded_at).toBe('string');
    // ...scoped to exactly that code.
    expect(calls).toContainEqual({ method: 'eq', args: ['code', 'g7k2m4'] });
  });

  it('throws when the update errors', async () => {
    const { client } = recordingSupabase({ data: null, error: { message: 'boom' } });
    await expect(markReminded(client, 'g7k2m4')).rejects.toThrow(/markReminded failed: boom/);
  });
});

describe('cleanupOld', () => {
  it('only deletes rows still in pending status', async () => {
    const { calls, client } = recordingSupabase({ data: [{ code: 'old123' }], error: null });
    const removed = await cleanupOld(client, 14);
    expect(removed).toBe(1);
    // Completed rows must survive GC so returning users get "you're already
    // in" instead of "couldn't find that code".
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
  });
});
