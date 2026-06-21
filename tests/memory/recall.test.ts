// tests/memory/recall.test.ts
// Per-turn Recall. Produces the render-ready "## THINGS YOU REMEMBER" block that
// Phase 2.2 injects into the prompt. Must be cheap, never throw, never block a
// reply — any failure or OFF flag → '' (empty, zero-cost, byte-identical prompt).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// createSupabaseObservationDB (the lazy default) builds a real service-role client;
// @supabase/supabase-js validates the URL at construction. Set dummies so importing
// the module / any accidental construction does not blow up. Match the repo idiom.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

// vi.hoisted so the mock fns exist before the module factories run.
const { resolveMock, logMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  logMock: vi.fn(),
}));

vi.mock('../../src/db/students.js', () => ({
  resolveProfileUserId: resolveMock,
}));

vi.mock('../../src/observability/logger.js', () => ({ log: logMock }));

import { recallForTurn, isRecallEnabled } from '../../src/memory/recall.js';
import type { RecalledObservation, ObservationDB } from '../../src/memory/observations.js';

const HANDLE = '+17474638880';
const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const EMB = [0.1, 0.2, 0.3];

function row(content: string, over: Partial<RecalledObservation> = {}): RecalledObservation {
  return {
    id: 1,
    content,
    salience: 4,
    kind: null,
    created_at: 't',
    score: 0.9,
    ...over,
  };
}

// A fake ObservationDB whose recall() returns the configured rows (and records
// the args it was called with). All other methods are unused no-ops.
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

beforeEach(() => {
  resolveMock.mockReset();
  logMock.mockReset();
  delete process.env.GEORGE_RECALL_ENABLED;
  delete process.env.RECALL_TOP_K;
  delete process.env.RECALL_MIN_SALIENCE;
  delete process.env.RECALL_HALF_LIFE_DAYS;
  resolveMock.mockResolvedValue(UID);
});

afterEach(() => {
  delete process.env.GEORGE_RECALL_ENABLED;
  delete process.env.RECALL_TOP_K;
  delete process.env.RECALL_MIN_SALIENCE;
  delete process.env.RECALL_HALF_LIFE_DAYS;
});

describe('isRecallEnabled', () => {
  it('reflects GEORGE_RECALL_ENABLED === "true"', () => {
    expect(isRecallEnabled()).toBe(false);
    process.env.GEORGE_RECALL_ENABLED = 'true';
    expect(isRecallEnabled()).toBe(true);
    process.env.GEORGE_RECALL_ENABLED = '1';
    expect(isRecallEnabled()).toBe(false);
  });
});

describe('recallForTurn — disabled (default OFF)', () => {
  it('returns "" and makes NO db/embed/resolve calls', async () => {
    const embed = vi.fn();
    const { db, calls } = makeDB([row('a')]);
    const out = await recallForTurn(HANDLE, 'where do I study', { db, embed });
    expect(out).toBe('');
    expect(embed).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('recallForTurn — enabled gates', () => {
  beforeEach(() => {
    process.env.GEORGE_RECALL_ENABLED = 'true';
  });

  it('non-onboarded handle (resolve → null) → ""', async () => {
    resolveMock.mockResolvedValue(null);
    const embed = vi.fn();
    const { db, calls } = makeDB([row('a')]);
    expect(await recallForTurn(HANDLE, 'hi', { db, embed })).toBe('');
    expect(embed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('empty / whitespace message → ""', async () => {
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    expect(await recallForTurn(HANDLE, '', { db, embed })).toBe('');
    expect(await recallForTurn(HANDLE, '   \n\t', { db, embed })).toBe('');
    expect(embed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('embed returns null → ""', async () => {
    const embed = vi.fn(async () => null);
    const { db, calls } = makeDB([row('a')]);
    expect(await recallForTurn(HANDLE, 'hi', { db, embed })).toBe('');
    expect(calls).toEqual([]);
  });

  it('db.recall returns [] → ""', async () => {
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB([]);
    expect(await recallForTurn(HANDLE, 'hi', { db, embed })).toBe('');
  });
});

describe('recallForTurn — rendering', () => {
  beforeEach(() => {
    process.env.GEORGE_RECALL_ENABLED = 'true';
  });

  it('renders header + "- " lines in order, and passes uuid + embedding + topK(4)/minSalience(2)', async () => {
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([
      row('sleeps at 3am', { id: 1 }),
      row('celebrated a Pear offer', { id: 2 }),
      row('stressed about visa', { id: 3 }),
    ]);
    const out = await recallForTurn(HANDLE, 'how am I doing', { db, embed });

    expect(out).toBe(
      '## THINGS YOU REMEMBER\n' +
        '- sleeps at 3am\n' +
        '- celebrated a Pear offer\n' +
        '- stressed about visa',
    );
    expect(embed).toHaveBeenCalledWith('how am I doing');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      userId: UID,
      embedding: EMB,
      matchCount: 4,
      minSalience: 2,
      halfLifeDays: 14,
    });
  });

  it('hard-caps the block at ~600 chars without cutting mid-line, header always present', async () => {
    const long = 'x'.repeat(120);
    const rows = Array.from({ length: 20 }, (_, i) => row(`${long}-${i}`, { id: i }));
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB(rows);
    const out = await recallForTurn(HANDLE, 'tell me everything', { db, embed });

    expect(out.length).toBeLessThanOrEqual(620); // ~600 cap, small slack
    expect(out.startsWith('## THINGS YOU REMEMBER\n- ')).toBe(true);
    // No mid-line truncation: every content line is a whole row.
    const lines = out.split('\n');
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^- x{120}-\d+$/);
    }
    // Trailing whitespace trimmed.
    expect(out).toBe(out.trimEnd());
  });

  it('keeps header + 1 line even if a single row alone exceeds the cap', async () => {
    const huge = 'y'.repeat(2000);
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB([row(huge)]);
    const out = await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(out).toBe(`## THINGS YOU REMEMBER\n- ${huge}`);
  });
});

describe('recallForTurn — env overrides', () => {
  beforeEach(() => {
    process.env.GEORGE_RECALL_ENABLED = 'true';
  });

  it('reads RECALL_TOP_K and RECALL_MIN_SALIENCE and passes them to db.recall', async () => {
    process.env.RECALL_TOP_K = '2';
    process.env.RECALL_MIN_SALIENCE = '3';
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(calls[0].matchCount).toBe(2);
    expect(calls[0].minSalience).toBe(3);
  });

  it('floors topK at 1 and clamps minSalience into 1..5', async () => {
    process.env.RECALL_TOP_K = '0';
    process.env.RECALL_MIN_SALIENCE = '99';
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(calls[0].matchCount).toBe(1);
    expect(calls[0].minSalience).toBe(5);
  });

  it('falls back to defaults topK(4)/minSalience(2) on unparseable env', async () => {
    process.env.RECALL_TOP_K = 'abc';
    process.env.RECALL_MIN_SALIENCE = 'xyz';
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(calls[0].matchCount).toBe(4);
    expect(calls[0].minSalience).toBe(2);
  });

  it('passes the default halfLifeDays(14) when RECALL_HALF_LIFE_DAYS is unset', async () => {
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(calls[0].halfLifeDays).toBe(14);
  });

  it('reads RECALL_HALF_LIFE_DAYS and passes it through to db.recall', async () => {
    process.env.RECALL_HALF_LIFE_DAYS = '7';
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(calls[0].halfLifeDays).toBe(7);
  });

  it('floors halfLifeDays at 1 and falls back to default on unparseable env', async () => {
    process.env.RECALL_HALF_LIFE_DAYS = '0';
    const embed = vi.fn(async () => EMB);
    const { db, calls } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(calls[0].halfLifeDays).toBe(1);

    process.env.RECALL_HALF_LIFE_DAYS = 'nope';
    const { db: db2, calls: calls2 } = makeDB([row('a')]);
    await recallForTurn(HANDLE, 'hi', { db: db2, embed });
    expect(calls2[0].halfLifeDays).toBe(14);
  });
});

describe('recallForTurn — success telemetry (recall_injected)', () => {
  beforeEach(() => {
    process.env.GEORGE_RECALL_ENABLED = 'true';
  });

  it('logs info recall_injected with count (rendered lines) + topScore when a non-empty block is returned', async () => {
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB([
      row('sleeps at 3am', { id: 1, score: 0.91234 }),
      row('celebrated a Pear offer', { id: 2, score: 0.5 }),
      row('stressed about visa', { id: 3, score: 0.4 }),
    ]);
    const out = await recallForTurn(HANDLE, 'how am I doing', { db, embed });

    expect(out).not.toBe('');
    const renderedLines = out.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(renderedLines).toBe(3);

    const injected = logMock.mock.calls.find((c) => c[1] === 'recall_injected');
    expect(injected).toBeDefined();
    expect(injected![0]).toBe('info');
    expect(injected![2]).toEqual({ userId: HANDLE, count: renderedLines, topScore: 0.912 });
  });

  it('count reflects rows actually injected after the 600-char cap, not the raw row count', async () => {
    const long = 'x'.repeat(120);
    const rows = Array.from({ length: 20 }, (_, i) => row(`${long}-${i}`, { id: i, score: 0.8 }));
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB(rows);
    const out = await recallForTurn(HANDLE, 'tell me everything', { db, embed });

    const renderedLines = out.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(renderedLines).toBeLessThan(20); // capped, fewer than the 20 raw rows

    const injected = logMock.mock.calls.find((c) => c[1] === 'recall_injected');
    expect(injected).toBeDefined();
    expect(injected![2]).toMatchObject({ count: renderedLines });
  });

  it('does NOT log recall_injected on the disabled (OFF) path', async () => {
    delete process.env.GEORGE_RECALL_ENABLED;
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB([row('a')]);
    expect(await recallForTurn(HANDLE, 'hi', { db, embed })).toBe('');
    expect(logMock.mock.calls.find((c) => c[1] === 'recall_injected')).toBeUndefined();
  });

  it('does NOT log recall_injected on an empty-block path (db.recall returns [])', async () => {
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB([]);
    expect(await recallForTurn(HANDLE, 'hi', { db, embed })).toBe('');
    expect(logMock.mock.calls.find((c) => c[1] === 'recall_injected')).toBeUndefined();
  });
});

describe('recallForTurn — robustness', () => {
  beforeEach(() => {
    process.env.GEORGE_RECALL_ENABLED = 'true';
  });

  it('db.recall throws → "" (no throw) and warns recall_failed', async () => {
    const embed = vi.fn(async () => EMB);
    const { db } = makeDB(async () => {
      throw new Error('rpc exploded');
    });
    const out = await recallForTurn(HANDLE, 'hi', { db, embed });
    expect(out).toBe('');
    const warn = logMock.mock.calls.find((c) => c[1] === 'recall_failed');
    expect(warn).toBeDefined();
    expect(warn![0]).toBe('warn');
    expect(warn![2]).toMatchObject({ error: 'rpc exploded' });
  });
});
