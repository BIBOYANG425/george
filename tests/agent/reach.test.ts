// tests/agent/reach.test.ts
//
// Unit tests for the re-reach evaluator engine. Covers the PURE candidacy gate
// (shouldReachCandidate), the flag-off no-op, fire-and-forget error swallowing,
// the dedup stamp (alreadyReached / markReached only-on-send), and the tone-
// variant voiceLint fallback. All deps are mocked — no DB, no Spectrum, no LLM.

// Stub env BEFORE config.ts loads (reach.ts imports bia-lore -> config). Lazy-
// import-after-stub pattern, same as relationship.test.ts.
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_ANON_KEY ||= 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ReachMod = typeof import('../../src/agent/evaluators/reach.js');
let reach: ReachMod;
beforeEach(async () => {
  reach = await import('../../src/agent/evaluators/reach.js');
});

const ENABLE = 'SQUAD_REREACH_EVAL_ENABLED';
const STALE = 'SQUAD_REREACH_STALE_HOURS';

function candidate(over: Partial<import('../../src/agent/evaluators/reach.js').ReachCandidate> = {}) {
  return {
    postId: 'p1',
    studentId: 's1',
    posterName: '学长',
    category: '拼车',
    location: 'K-town',
    lastActivityAt: new Date(Date.now() - 72 * 3600_000).toISOString(), // 72h ago, stale
    ...over,
  };
}

function makeDeps(over: Partial<import('../../src/agent/evaluators/reach.js').ReachEvalDeps> = {}) {
  return {
    selectReachCandidates: vi.fn(async () => [candidate()]),
    handleFor: vi.fn(async () => 'handle1'),
    sendProactive: vi.fn(async () => {}),
    markReached: vi.fn(async () => {}),
    alreadyReached: vi.fn(async () => false),
    ...over,
  };
}

describe('isReachEvalEnabled', () => {
  const orig = process.env[ENABLE];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENABLE];
    else process.env[ENABLE] = orig;
  });
  it('is OFF when unset', () => {
    delete process.env[ENABLE];
    expect(reach.isReachEvalEnabled()).toBe(false);
  });
  it('is ON only for the exact string "true"', () => {
    process.env[ENABLE] = 'true';
    expect(reach.isReachEvalEnabled()).toBe(true);
    process.env[ENABLE] = '1';
    expect(reach.isReachEvalEnabled()).toBe(false);
  });
});

describe('reachStaleHours', () => {
  const orig = process.env[STALE];
  afterEach(() => {
    if (orig === undefined) delete process.env[STALE];
    else process.env[STALE] = orig;
  });
  it('defaults to 48 when unset', () => {
    delete process.env[STALE];
    expect(reach.reachStaleHours()).toBe(48);
  });
  it('reads a positive override', () => {
    process.env[STALE] = '12';
    expect(reach.reachStaleHours()).toBe(12);
  });
  it('falls back to the default on NaN / non-positive', () => {
    process.env[STALE] = 'abc';
    expect(reach.reachStaleHours()).toBe(48);
    process.env[STALE] = '0';
    expect(reach.reachStaleHours()).toBe(48);
    process.env[STALE] = '-5';
    expect(reach.reachStaleHours()).toBe(48);
  });
});

describe('shouldReachCandidate (pure candidacy)', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  it('is stalled when last activity is older than the threshold', () => {
    const c = candidate({ lastActivityAt: new Date(now.getTime() - 50 * 3600_000).toISOString() });
    expect(reach.shouldReachCandidate(c, now, 48)).toBe(true);
  });
  it('is NOT stalled when last activity is within the threshold', () => {
    const c = candidate({ lastActivityAt: new Date(now.getTime() - 10 * 3600_000).toISOString() });
    expect(reach.shouldReachCandidate(c, now, 48)).toBe(false);
  });
  it('is exactly stalled at the threshold boundary', () => {
    const c = candidate({ lastActivityAt: new Date(now.getTime() - 48 * 3600_000).toISOString() });
    expect(reach.shouldReachCandidate(c, now, 48)).toBe(true);
  });
  it('rejects an unparseable timestamp', () => {
    const c = candidate({ lastActivityAt: 'not-a-date' });
    expect(reach.shouldReachCandidate(c, now, 48)).toBe(false);
  });
});

describe('reachBubble (grounded template)', () => {
  it('grounds the post fields, no banned phrases', () => {
    const b = reach.reachBubble('拼车', 'K-town');
    expect(b).toContain('拼车');
    expect(b).toContain('K-town');
    expect(b).not.toContain('加油');
  });
  it('omits the location cleanly when null', () => {
    const b = reach.reachBubble('自习', null);
    expect(b).toContain('自习');
    expect(b).not.toContain('null');
  });
});

describe('runReachEval', () => {
  const orig = process.env[ENABLE];
  beforeEach(() => { process.env[ENABLE] = 'true'; });
  afterEach(() => {
    if (orig === undefined) delete process.env[ENABLE];
    else process.env[ENABLE] = orig;
  });

  it('is a no-op when the flag is OFF (no query, no send)', async () => {
    delete process.env[ENABLE];
    const deps = makeDeps();
    await reach.runReachEval(deps);
    expect(deps.selectReachCandidates).not.toHaveBeenCalled();
    expect(deps.sendProactive).not.toHaveBeenCalled();
  });

  it('sends a templated bubble to a stalled candidate then stamps it', async () => {
    const deps = makeDeps();
    await reach.runReachEval(deps);
    expect(deps.sendProactive).toHaveBeenCalledTimes(1);
    expect(deps.sendProactive.mock.calls[0][0]).toBe('handle1');
    expect(String(deps.sendProactive.mock.calls[0][1])).toContain('拼车');
    // Stamp only after a successful send.
    expect(deps.markReached).toHaveBeenCalledWith('p1', 's1');
  });

  it('skips a non-stalled candidate (pure gate)', async () => {
    const deps = makeDeps({
      selectReachCandidates: vi.fn(async () => [
        candidate({ lastActivityAt: new Date(Date.now() - 5 * 3600_000).toISOString() }),
      ]),
    });
    await reach.runReachEval(deps);
    expect(deps.sendProactive).not.toHaveBeenCalled();
    expect(deps.markReached).not.toHaveBeenCalled();
  });

  it('skips an already-reached candidate (dedup)', async () => {
    const deps = makeDeps({ alreadyReached: vi.fn(async () => true) });
    await reach.runReachEval(deps);
    expect(deps.sendProactive).not.toHaveBeenCalled();
    expect(deps.markReached).not.toHaveBeenCalled();
  });

  it('skips when there is no handle for the student', async () => {
    const deps = makeDeps({ handleFor: vi.fn(async () => null) });
    await reach.runReachEval(deps);
    expect(deps.sendProactive).not.toHaveBeenCalled();
    expect(deps.markReached).not.toHaveBeenCalled();
  });

  it('does NOT stamp when the send fails (cron is the retry)', async () => {
    const deps = makeDeps({ sendProactive: vi.fn(async () => { throw new Error('no_spectrum_connection'); }) });
    await expect(reach.runReachEval(deps)).resolves.toBeUndefined();
    expect(deps.markReached).not.toHaveBeenCalled();
  });

  it('swallows a query failure (never throws)', async () => {
    const deps = makeDeps({ selectReachCandidates: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(reach.runReachEval(deps)).resolves.toBeUndefined();
    expect(deps.sendProactive).not.toHaveBeenCalled();
  });

  it('one bad candidate does not block the next', async () => {
    const deps = makeDeps({
      selectReachCandidates: vi.fn(async () => [
        candidate({ postId: 'bad', studentId: 'sbad' }),
        candidate({ postId: 'good', studentId: 'sgood' }),
      ]),
      handleFor: vi.fn(async (sid: string) => (sid === 'sbad' ? null : 'handleGood')),
    });
    await reach.runReachEval(deps);
    // bad skipped (no handle), good sent + stamped.
    expect(deps.markReached).toHaveBeenCalledWith('good', 'sgood');
    expect(deps.markReached).not.toHaveBeenCalledWith('bad', 'sbad');
  });

  it('uses a lint-clean tone variant when composeTone provides one', async () => {
    const deps = makeDeps({ composeTone: vi.fn(async () => '诶 那个局还考虑吗 想去回我哈') });
    await reach.runReachEval(deps);
    expect(String(deps.sendProactive.mock.calls[0][1])).toContain('那个局还考虑吗');
  });

  it('falls back to the template when the tone variant fails voiceLint', async () => {
    // A banned phrase ("加油！") must be rejected and replaced by the template.
    const deps = makeDeps({ composeTone: vi.fn(async () => '加油！希望对你有帮助') });
    await reach.runReachEval(deps);
    expect(String(deps.sendProactive.mock.calls[0][1])).toContain('拼车'); // template, grounded
    expect(String(deps.sendProactive.mock.calls[0][1])).not.toContain('加油');
  });

  it('falls back to the template when composeTone throws', async () => {
    const deps = makeDeps({ composeTone: vi.fn(async () => { throw new Error('llm down'); }) });
    await reach.runReachEval(deps);
    expect(String(deps.sendProactive.mock.calls[0][1])).toContain('拼车');
    expect(deps.markReached).toHaveBeenCalledWith('p1', 's1');
  });
});

describe('reachEvaluator adapter', () => {
  const orig = process.env[ENABLE];
  afterEach(() => {
    reach.setReachEvalDeps(null);
    if (orig === undefined) delete process.env[ENABLE];
    else process.env[ENABLE] = orig;
  });

  it('is a cron-only llm evaluator with stable name', () => {
    expect(reach.reachEvaluator.name).toBe('rereach_eval');
    expect(reach.reachEvaluator.kind).toBe('llm');
    expect(reach.reachEvaluator.trigger).toBe('cron');
  });

  it('isEnabled tracks SQUAD_REREACH_EVAL_ENABLED', () => {
    delete process.env[ENABLE];
    expect(reach.reachEvaluator.isEnabled()).toBe(false);
    process.env[ENABLE] = 'true';
    expect(reach.reachEvaluator.isEnabled()).toBe(true);
  });

  it('shouldRun is false until deps are injected, true after', () => {
    expect(reach.reachEvaluator.shouldRun({ trigger: 'cron' })).toBe(false);
    reach.setReachEvalDeps(makeDeps());
    expect(reach.reachEvaluator.shouldRun({ trigger: 'cron' })).toBe(true);
  });

  it('run() drives the injected deps when enabled', async () => {
    process.env[ENABLE] = 'true';
    const deps = makeDeps();
    reach.setReachEvalDeps(deps);
    await reach.reachEvaluator.run({ trigger: 'cron' });
    expect(deps.selectReachCandidates).toHaveBeenCalledTimes(1);
  });

  it('run() is a safe no-op when no deps are set', async () => {
    reach.setReachEvalDeps(null);
    await expect(reach.reachEvaluator.run({ trigger: 'cron' })).resolves.toBeUndefined();
  });
});
