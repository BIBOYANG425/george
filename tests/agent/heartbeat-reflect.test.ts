// tests/agent/heartbeat-reflect.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isReflectEnabled,
  reflectObservations,
  type ObservationReflector,
} from '../../src/agent/heartbeat.js';
import type { UnconsolidatedObservation } from '../../src/memory/observations.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────
function makeStore() {
  const appends: Array<[string, string, string]> = [];
  return {
    appends,
    async appendToBlock(u: string, b: any, c: string) {
      appends.push([u, b, c]);
    },
  };
}

function makeObsDB(obs: UnconsolidatedObservation[]) {
  const calls = {
    loaded: [] as Array<[string, number, number]>,
    consolidated: [] as number[][],
    pruned: [] as Array<[string, number]>,
  };
  return {
    calls,
    async loadUnconsolidated(userId: string, minSalience: number, limit: number) {
      calls.loaded.push([userId, minSalience, limit]);
      return obs;
    },
    async markConsolidated(ids: number[]) {
      calls.consolidated.push(ids);
    },
    async prune(userId: string, pruneDays: number) {
      calls.pruned.push([userId, pruneDays]);
      return 0;
    },
  };
}

function obs(id: number, content: string, salience = 3): UnconsolidatedObservation {
  return { id, content, salience, kind: 'event', created_at: '2026-06-21T00:00:00Z' };
}

const ENV_KEYS = ['GEORGE_REFLECT_ENABLED', 'REFLECT_PRUNE_DAYS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Gate ────────────────────────────────────────────────────────────────────
describe('isReflectEnabled', () => {
  it('is false when GEORGE_REFLECT_ENABLED is unset', () => {
    expect(isReflectEnabled()).toBe(false);
  });
  it('is false for any value other than "true"', () => {
    process.env.GEORGE_REFLECT_ENABLED = '1';
    expect(isReflectEnabled()).toBe(false);
    process.env.GEORGE_REFLECT_ENABLED = 'TRUE';
    expect(isReflectEnabled()).toBe(false);
  });
  it('is true only for exactly "true"', () => {
    process.env.GEORGE_REFLECT_ENABLED = 'true';
    expect(isReflectEnabled()).toBe(true);
  });
});

// ── reflectObservations ───────────────────────────────────────────────────────
describe('reflectObservations', () => {
  it('folds a returned append into the block, consolidates BOTH ids, prunes with default 30', async () => {
    const store = makeStore();
    const db = makeObsDB([obs(1, 'pulled an all-nighter again'), obs(2, 'stressed about midterms')]);
    const reflect: ObservationReflector = async () => [
      { block: 'state', text: '  recurring late-night study pattern under exam stress  ' },
    ];

    await reflectObservations(store as any, db as any, 'u1', reflect);

    expect(store.appends).toEqual([['u1', 'state', 'recurring late-night study pattern under exam stress']]);
    expect(db.calls.consolidated).toEqual([[1, 2]]);
    expect(db.calls.pruned).toEqual([['u1', 30]]);
    // loaded with the reused min-salience default (2) and LIMIT 50
    expect(db.calls.loaded).toEqual([['u1', 2, 50]]);
  });

  it('honors REFLECT_PRUNE_DAYS when set', async () => {
    process.env.REFLECT_PRUNE_DAYS = '7';
    const store = makeStore();
    const db = makeObsDB([obs(5, 'something')]);
    const reflect: ObservationReflector = async () => [];

    await reflectObservations(store as any, db as any, 'u1', reflect);

    expect(db.calls.pruned).toEqual([['u1', 7]]);
  });

  it('still prunes when there are no observations (no append, markConsolidated([]) or skipped)', async () => {
    const store = makeStore();
    const db = makeObsDB([]);
    let reflectCalled = false;
    const reflect: ObservationReflector = async () => {
      reflectCalled = true;
      return [];
    };

    await reflectObservations(store as any, db as any, 'u1', reflect);

    expect(reflectCalled).toBe(false); // short-circuits, doesn't call reflect on empty
    expect(store.appends).toEqual([]);
    // markConsolidated either skipped or called with [] — both fine; assert no real ids
    for (const ids of db.calls.consolidated) expect(ids).toEqual([]);
    expect(db.calls.pruned).toEqual([['u1', 30]]);
  });

  it('skips invalid block names and empty text, applies the valid ones, consolidates ALL', async () => {
    const store = makeStore();
    const db = makeObsDB([obs(1, 'a'), obs(2, 'b'), obs(3, 'c')]);
    const reflect: ObservationReflector = async () => [
      { block: 'george_notes' as any, text: 'should be skipped — scratchpad excluded' },
      { block: 'nonsense' as any, text: 'should be skipped — invalid block' },
      { block: 'interests', text: '   ' }, // empty after trim → skipped
      { block: 'academic', text: 'declared CS major' }, // valid
    ];

    await reflectObservations(store as any, db as any, 'u1', reflect);

    expect(store.appends).toEqual([['u1', 'academic', 'declared CS major']]);
    expect(db.calls.consolidated).toEqual([[1, 2, 3]]);
    expect(db.calls.pruned).toEqual([['u1', 30]]);
  });

  it('does NOT throw when reflect throws (fail-safe); leaves rows un-consolidated', async () => {
    const store = makeStore();
    const db = makeObsDB([obs(1, 'a')]);
    const reflect: ObservationReflector = async () => {
      throw new Error('LLM exploded');
    };

    await expect(reflectObservations(store as any, db as any, 'u1', reflect)).resolves.toBeUndefined();
    expect(store.appends).toEqual([]);
    // fail-safe path: markConsolidated not reached on the throwing path is acceptable
    expect(db.calls.consolidated).toEqual([]);
  });

  it('does NOT throw when appendToBlock throws (fail-safe)', async () => {
    const db = makeObsDB([obs(1, 'a')]);
    const store = {
      async appendToBlock() {
        throw new Error('db write failed');
      },
    };
    const reflect: ObservationReflector = async () => [{ block: 'state', text: 'note' }];

    await expect(reflectObservations(store as any, db as any, 'u1', reflect)).resolves.toBeUndefined();
    // threw before markConsolidated → rows left for next tick
    expect(db.calls.consolidated).toEqual([]);
  });
});
