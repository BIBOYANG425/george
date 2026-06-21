// tests/scripts/backfill-observations.test.ts
// Unit tests for the observation backfill core (backfillForUser + pairTurns).
// All deps are faked — no network, no LLM, no Supabase. Covers turn pairing,
// dry-run vs execute, non-onboarded skip, salience clamping at insert, and
// per-turn resilience (one throwing extract doesn't abort the rest).
import { describe, it, expect, vi } from 'vitest';
import {
  pairTurns,
  backfillForUser,
  parseArgs,
  type MessageRow,
  type BackfillDeps,
} from '../../scripts/backfill-observations.js';

const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const HANDLE = '+17474638880';

function msg(role: string, content: string, created_at = '2026-06-01T00:00:00Z'): MessageRow {
  return { role, content, created_at };
}

// A recording fake ObservationDB.insert.
function makeObservationDB() {
  const inserts: Array<{ userId: string; obs: any; embedding: number[] | null }> = [];
  return {
    inserts,
    db: {
      async insert(userId: string, obs: any, embedding: number[] | null) {
        inserts.push({ userId, obs, embedding });
      },
    },
  };
}

// Build a full deps object with sensible defaults; override per test.
function makeDeps(overrides: Partial<BackfillDeps> = {}): { deps: BackfillDeps; inserts: any[] } {
  const { inserts, db } = makeObservationDB();
  const deps: BackfillDeps = {
    resolveUser: vi.fn(async () => UID),
    loadMessages: vi.fn(async () => []),
    extract: vi.fn(async () => ({ observations: [] })),
    embed: vi.fn(async () => [0.1, 0.2, 0.3]),
    observationDB: db,
    ...overrides,
  };
  return { deps, inserts };
}

describe('pairTurns', () => {
  it('pairs consecutive user→assistant turns', () => {
    const turns = pairTurns([
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', 'a2'),
    ]);
    expect(turns).toEqual([
      { userText: 'u1', assistantText: 'a1' },
      { userText: 'u2', assistantText: 'a2' },
    ]);
  });

  it('drops a trailing unanswered user message', () => {
    const turns = pairTurns([msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2')]);
    expect(turns).toEqual([{ userText: 'u1', assistantText: 'a1' }]);
  });

  it('a new user message supersedes a prior unanswered one', () => {
    const turns = pairTurns([msg('user', 'first'), msg('user', 'second'), msg('assistant', 'reply')]);
    expect(turns).toEqual([{ userText: 'second', assistantText: 'reply' }]);
  });

  it('ignores system messages without breaking pairing', () => {
    const turns = pairTurns([
      msg('system', 'sys'),
      msg('user', 'u1'),
      msg('system', 'sys2'),
      msg('assistant', 'a1'),
    ]);
    expect(turns).toEqual([{ userText: 'u1', assistantText: 'a1' }]);
  });

  it('drops a leading assistant message with no preceding user', () => {
    const turns = pairTurns([msg('assistant', 'orphan'), msg('user', 'u1'), msg('assistant', 'a1')]);
    expect(turns).toEqual([{ userText: 'u1', assistantText: 'a1' }]);
  });
});

describe('backfillForUser — dry-run (default)', () => {
  it('counts turns and observations but inserts nothing', async () => {
    const { deps, inserts } = makeDeps({
      loadMessages: vi.fn(async () => [
        msg('user', 'I got a Pear offer!'),
        msg('assistant', 'lfg'),
        msg('user', 'finals tho'),
        msg('assistant', 'rip'),
      ]),
      extract: vi
        .fn()
        .mockResolvedValueOnce({ observations: [{ content: 'celebrated a Pear offer', salience: 5, kind: 'event' }] })
        .mockResolvedValueOnce({ observations: [{ content: 'stressed about finals', salience: 4, kind: 'emotion' }] }),
    });

    const r = await backfillForUser(deps, HANDLE); // no opts → dry-run

    expect(r.resolved).toBe(true);
    expect(r.userId).toBe(UID);
    expect(r.scanned).toBe(2);
    expect(r.extracted).toBe(2);
    expect(r.inserted).toBe(2); // "would insert" count
    expect(inserts).toEqual([]); // nothing actually written
  });
});

describe('backfillForUser — execute mode', () => {
  it('calls observationDB.insert per observation with clamped salience and validated kind', async () => {
    const { deps, inserts } = makeDeps({
      loadMessages: vi.fn(async () => [msg('user', 'x'), msg('assistant', 'y')]),
      extract: vi.fn(async () => ({
        observations: [
          { content: 'over the top', salience: 9, kind: 'event' }, // → 5
          { content: 'below floor', salience: 0, kind: 'event' }, // → 1
          { content: 'bad kind', salience: 3, kind: 'habit' }, // kind → undefined
          { content: '   ', salience: 3, kind: 'event' }, // empty → skipped
        ],
      })),
    });

    const r = await backfillForUser(deps, HANDLE, { execute: true });

    expect(r.scanned).toBe(1);
    expect(r.extracted).toBe(3); // whitespace-only dropped
    expect(r.inserted).toBe(3);
    expect(inserts).toHaveLength(3);
    expect(inserts.map((i) => i.userId)).toEqual([UID, UID, UID]);
    expect(inserts.map((i) => i.obs.salience)).toEqual([5, 1, 3]);
    expect(inserts[0].obs.kind).toBe('event');
    expect(inserts[2].obs.kind).toBeUndefined();
    // embedding passed through
    expect(inserts[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('passes a null embedding through when embed returns null', async () => {
    const { deps, inserts } = makeDeps({
      loadMessages: vi.fn(async () => [msg('user', 'x'), msg('assistant', 'y')]),
      extract: vi.fn(async () => ({ observations: [{ content: 'pulled an all-nighter', salience: 3, kind: 'event' }] })),
      embed: vi.fn(async () => null),
    });
    const r = await backfillForUser(deps, HANDLE, { execute: true });
    expect(r.inserted).toBe(1);
    expect(inserts[0].embedding).toBeNull();
  });

  it('honours per-turn-cap', async () => {
    const { deps, inserts } = makeDeps({
      loadMessages: vi.fn(async () => [msg('user', 'x'), msg('assistant', 'y')]),
      extract: vi.fn(async () => ({
        observations: [
          { content: 'one', salience: 3, kind: 'event' },
          { content: 'two', salience: 3, kind: 'event' },
          { content: 'three', salience: 3, kind: 'event' },
        ],
      })),
    });
    const r = await backfillForUser(deps, HANDLE, { execute: true, perTurnCap: 2 });
    expect(r.extracted).toBe(2);
    expect(r.inserted).toBe(2);
    expect(inserts.map((i) => i.obs.content)).toEqual(['one', 'two']);
  });
});

describe('backfillForUser — non-onboarded user', () => {
  it('is skipped entirely (no message load, no extract, no insert)', async () => {
    const { deps, inserts } = makeDeps({
      resolveUser: vi.fn(async () => null),
    });
    const r = await backfillForUser(deps, HANDLE, { execute: true });
    expect(r.resolved).toBe(false);
    expect(r.userId).toBeNull();
    expect(r.scanned).toBe(0);
    expect(r.inserted).toBe(0);
    expect(deps.loadMessages).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});

describe('backfillForUser — resilience', () => {
  it('a throwing extract on one turn does not abort the rest', async () => {
    const { deps, inserts } = makeDeps({
      loadMessages: vi.fn(async () => [
        msg('user', 'u1'),
        msg('assistant', 'a1'),
        msg('user', 'u2'),
        msg('assistant', 'a2'),
        msg('user', 'u3'),
        msg('assistant', 'a3'),
      ]),
      extract: vi
        .fn()
        .mockResolvedValueOnce({ observations: [{ content: 'first ok', salience: 3, kind: 'event' }] })
        .mockRejectedValueOnce(new Error('LLM blew up'))
        .mockResolvedValueOnce({ observations: [{ content: 'third ok', salience: 3, kind: 'event' }] }),
    });

    const r = await backfillForUser(deps, HANDLE, { execute: true });

    expect(r.scanned).toBe(3); // all three turns attempted
    expect(r.extracted).toBe(2); // middle one threw
    expect(r.inserted).toBe(2);
    expect(inserts.map((i) => i.obs.content)).toEqual(['first ok', 'third ok']);
  });

  it('a throwing insert on one observation does not abort the rest of the user', async () => {
    let calls = 0;
    const inserts: any[] = [];
    const deps: BackfillDeps = {
      resolveUser: vi.fn(async () => UID),
      loadMessages: vi.fn(async () => [
        msg('user', 'u1'),
        msg('assistant', 'a1'),
        msg('user', 'u2'),
        msg('assistant', 'a2'),
      ]),
      extract: vi
        .fn()
        .mockResolvedValueOnce({ observations: [{ content: 'turn1', salience: 3, kind: 'event' }] })
        .mockResolvedValueOnce({ observations: [{ content: 'turn2', salience: 3, kind: 'event' }] }),
      embed: vi.fn(async () => null),
      observationDB: {
        async insert(userId: string, obs: any, embedding: number[] | null) {
          calls++;
          if (calls === 1) throw new Error('transient insert failure');
          inserts.push({ userId, obs, embedding });
        },
      },
    };

    const r = await backfillForUser(deps, HANDLE, { execute: true });

    expect(r.scanned).toBe(2);
    // turn1's insert threw (counted toward extracted but its inserted++ never
    // ran); turn2 succeeded.
    expect(inserts.map((i) => i.obs.content)).toEqual(['turn2']);
    expect(r.inserted).toBe(1);
  });
});

describe('parseArgs', () => {
  it('defaults to dry-run with the default limit', () => {
    const a = parseArgs(['--user', HANDLE]);
    expect(a).toMatchObject({ user: HANDLE, all: false, execute: false, limit: 400 });
  });

  it('parses --all --execute --limit --per-turn-cap', () => {
    const a = parseArgs(['--all', '--execute', '--limit', '50', '--per-turn-cap', '3']);
    expect(a).toMatchObject({ all: true, execute: true, limit: 50, perTurnCap: 3 });
  });
});
