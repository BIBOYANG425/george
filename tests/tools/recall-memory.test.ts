// tests/tools/recall-memory.test.ts
// P6 Phase 5 (post-MVP): the deliberate recall_memory tool. Mirrors the recall.ts
// test idiom — fake ObservationDB + fake embed + mocked resolveProfileUserId, zero
// network/LLM. Asserts: matched observations returned; empty / no-results / non-
// onboarded → graceful empty; never throws; and gating (tool ABSENT from the
// assembled tool set when GEORGE_RECALL_TOOL_ENABLED is unset, PRESENT when set).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// createSupabaseObservationDB (the lazy default) builds a real service-role client;
// @supabase/supabase-js validates the URL at construction. Set dummies so importing
// the module / any accidental construction does not blow up. Match the repo idiom.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import {
  recallMemoryHandler,
  isRecallToolEnabled,
  type RecallMemoryDeps,
} from '../../src/tools/recall-memory.js';
import type { RecalledObservation, ObservationDB } from '../../src/memory/observations.js';

const HANDLE = '+17474638880';
const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const EMB = [0.1, 0.2, 0.3];

function row(content: string, over: Partial<RecalledObservation> = {}): RecalledObservation {
  return { id: 1, content, salience: 4, kind: null, created_at: 't', score: 0.9, ...over };
}

// A fake ObservationDB whose recall() returns the configured rows (and records the
// args it was called with). All other methods are unused no-ops. Mirrors recall.test.ts.
function makeDB(rows: RecalledObservation[] | (() => Promise<RecalledObservation[]>)) {
  const calls: Array<{ userId: string; embedding: number[]; matchCount: number; minSalience: number; halfLifeDays: number }> = [];
  const db: ObservationDB = {
    async insert() {},
    async recall(userId, embedding, matchCount, minSalience, halfLifeDays) {
      calls.push({ userId, embedding, matchCount, minSalience, halfLifeDays });
      return typeof rows === 'function' ? rows() : rows;
    },
    async loadUnconsolidated() { return []; },
    async markConsolidated() {},
    async prune() { return 0; },
    async deleteForUser() {},
  };
  return { db, calls };
}

// Default-happy deps: resolves HANDLE→UID, embeds to EMB, returns the given rows.
function deps(rows: RecalledObservation[] | (() => Promise<RecalledObservation[]>)): {
  d: RecallMemoryDeps;
  calls: ReturnType<typeof makeDB>['calls'];
  resolve: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
} {
  const { db, calls } = makeDB(rows);
  const resolve = vi.fn(async () => UID);
  const embed = vi.fn(async () => EMB);
  return { d: { db, resolve, embed }, calls, resolve, embed };
}

beforeEach(() => {
  delete process.env.RECALL_TOP_K;
  delete process.env.RECALL_MIN_SALIENCE;
  delete process.env.RECALL_HALF_LIFE_DAYS;
});
afterEach(() => {
  delete process.env.RECALL_TOP_K;
  delete process.env.RECALL_MIN_SALIENCE;
  delete process.env.RECALL_HALF_LIFE_DAYS;
});

describe('isRecallToolEnabled', () => {
  const orig = process.env.GEORGE_RECALL_TOOL_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.GEORGE_RECALL_TOOL_ENABLED;
    else process.env.GEORGE_RECALL_TOOL_ENABLED = orig;
  });
  it('reflects GEORGE_RECALL_TOOL_ENABLED === "true" exactly', () => {
    delete process.env.GEORGE_RECALL_TOOL_ENABLED;
    expect(isRecallToolEnabled()).toBe(false);
    process.env.GEORGE_RECALL_TOOL_ENABLED = 'true';
    expect(isRecallToolEnabled()).toBe(true);
    process.env.GEORGE_RECALL_TOOL_ENABLED = '1';
    expect(isRecallToolEnabled()).toBe(false);
  });
});

describe('recallMemoryHandler — happy path', () => {
  it('returns matched observations (content/salience/kind), resolving handle → uuid', async () => {
    const { d, calls, resolve, embed } = deps([
      row('sleeps at 3am', { id: 1, salience: 5, kind: 'habit' }),
      row('stressed about visa', { id: 2, salience: 4, kind: 'emotion' }),
    ]);
    const out = await recallMemoryHandler({ query: 'visa stuff', user_id: HANDLE }, d);
    const parsed = JSON.parse(out);
    expect(parsed.memories).toEqual([
      { content: 'sleeps at 3am', salience: 5, kind: 'habit' },
      { content: 'stressed about visa', salience: 4, kind: 'emotion' },
    ]);
    expect(resolve).toHaveBeenCalledWith(HANDLE);
    expect(embed).toHaveBeenCalledWith('visa stuff');
    // Keyed by the RESOLVED uuid, with the shared recall tunables (defaults).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ userId: UID, embedding: EMB, matchCount: 4, minSalience: 2, halfLifeDays: 14 });
  });

  it('reuses RECALL_TOP_K / RECALL_MIN_SALIENCE / RECALL_HALF_LIFE_DAYS tunables', async () => {
    process.env.RECALL_TOP_K = '7';
    process.env.RECALL_MIN_SALIENCE = '3';
    process.env.RECALL_HALF_LIFE_DAYS = '5';
    const { d, calls } = deps([row('a')]);
    await recallMemoryHandler({ query: 'q', user_id: HANDLE }, d);
    expect(calls[0]).toMatchObject({ matchCount: 7, minSalience: 3, halfLifeDays: 5 });
  });
});

describe('recallMemoryHandler — graceful empties (never throws, no fabrication)', () => {
  const EMPTY = JSON.stringify({ memories: [], note: 'no relevant memories found' });

  it('no rows → graceful empty', async () => {
    const { d } = deps([]);
    expect(await recallMemoryHandler({ query: 'q', user_id: HANDLE }, d)).toBe(EMPTY);
  });

  it('non-onboarded handle (resolve → null) → graceful empty, no embed/recall', async () => {
    const { db, calls } = makeDB([row('a')]);
    const resolve = vi.fn(async () => null);
    const embed = vi.fn(async () => EMB);
    const out = await recallMemoryHandler({ query: 'q', user_id: HANDLE }, { db, resolve, embed });
    expect(out).toBe(EMPTY);
    expect(embed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('empty / whitespace query → graceful empty, no resolve/embed/recall', async () => {
    const { d, calls, resolve, embed } = deps([row('a')]);
    expect(await recallMemoryHandler({ query: '   ', user_id: HANDLE }, d)).toBe(EMPTY);
    expect(resolve).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('missing user_id handle → graceful empty', async () => {
    const { d } = deps([row('a')]);
    expect(await recallMemoryHandler({ query: 'q' }, d)).toBe(EMPTY);
  });

  it('embed returns null → graceful empty, no recall', async () => {
    const { db, calls } = makeDB([row('a')]);
    const resolve = vi.fn(async () => UID);
    const embed = vi.fn(async () => null);
    expect(await recallMemoryHandler({ query: 'q', user_id: HANDLE }, { db, resolve, embed })).toBe(EMPTY);
    expect(calls).toEqual([]);
  });

  it('db.recall throws → graceful empty (no throw)', async () => {
    const { d } = deps(async () => { throw new Error('rpc exploded'); });
    await expect(recallMemoryHandler({ query: 'q', user_id: HANDLE }, d)).resolves.toBe(EMPTY);
  });

  it('resolve throws → graceful empty (no throw)', async () => {
    const db = makeDB([row('a')]).db;
    const resolve = vi.fn(async () => { throw new Error('db down'); });
    await expect(
      recallMemoryHandler({ query: 'q', user_id: HANDLE }, { db, resolve, embed: vi.fn(async () => EMB) }),
    ).resolves.toBe(EMPTY);
  });
});
