// tests/agent/evaluators-registry.test.ts
//
// Unit tests for the shared evaluator dispatcher (registry.ts). Covers the
// fire-and-forget contract: enabled-gating, shouldRun-gating, and the guarantee
// that a throwing run() (or shouldRun()) never escapes the dispatcher.

// Stub required env vars BEFORE config.ts loads (the registry imports evaluators
// that import config). Same lazy-import-after-stub pattern as relationship.test.ts.
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_ANON_KEY ||= 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Evaluator, EvalContext } from '../../src/agent/evaluators/types.js';

type RegMod = typeof import('../../src/agent/evaluators/registry.js');
let reg: RegMod;
beforeEach(async () => {
  reg = await import('../../src/agent/evaluators/registry.js');
});

function makeEvaluator(over: Partial<Evaluator> = {}): Evaluator {
  return {
    name: 'test_eval',
    kind: 'pure',
    trigger: 'turn',
    isEnabled: () => true,
    shouldRun: () => true,
    run: vi.fn(async () => {}),
    ...over,
  };
}

const ctx: EvalContext = { userId: 'u1', trigger: 'turn' };

describe('runEvaluatorSafely', () => {
  it('does NOT run when isEnabled() is false (gate before any work)', async () => {
    const run = vi.fn(async () => {});
    const shouldRun = vi.fn(() => true);
    const ev = makeEvaluator({ isEnabled: () => false, shouldRun, run });
    await reg.runEvaluatorSafely(ev, ctx);
    expect(shouldRun).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('does NOT run when shouldRun() is false', async () => {
    const run = vi.fn(async () => {});
    const ev = makeEvaluator({ shouldRun: () => false, run });
    await reg.runEvaluatorSafely(ev, ctx);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs when enabled and shouldRun is true', async () => {
    const run = vi.fn(async () => {});
    const ev = makeEvaluator({ run });
    await reg.runEvaluatorSafely(ev, ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('awaits an async shouldRun', async () => {
    const run = vi.fn(async () => {});
    const ev = makeEvaluator({ shouldRun: async () => true, run });
    await reg.runEvaluatorSafely(ev, ctx);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing run() (never throws into the caller)', async () => {
    const ev = makeEvaluator({ run: async () => { throw new Error('boom'); } });
    await expect(reg.runEvaluatorSafely(ev, ctx)).resolves.toBeUndefined();
  });

  it('swallows a throwing shouldRun() too', async () => {
    const run = vi.fn(async () => {});
    const ev = makeEvaluator({ shouldRun: () => { throw new Error('cadence boom'); }, run });
    await expect(reg.runEvaluatorSafely(ev, ctx)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('dispatchEvaluators', () => {
  it('runs every enabled+shouldRun evaluator concurrently', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    const list = [makeEvaluator({ name: 'a', run: a }), makeEvaluator({ name: 'b', run: b })];
    await reg.dispatchEvaluators(list, ctx);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('never throws even if one evaluator throws (allSettled isolates failures)', async () => {
    const good = vi.fn(async () => {});
    const list = [
      makeEvaluator({ name: 'bad', run: async () => { throw new Error('x'); } }),
      makeEvaluator({ name: 'good', run: good }),
    ];
    await expect(reg.dispatchEvaluators(list, ctx)).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('is a no-op loop when all evaluators are disabled', async () => {
    const run = vi.fn(async () => {});
    const list = [makeEvaluator({ isEnabled: () => false, run })];
    await reg.dispatchEvaluators(list, ctx);
    expect(run).not.toHaveBeenCalled();
  });

  it('handles an empty list', async () => {
    await expect(reg.dispatchEvaluators([], ctx)).resolves.toBeUndefined();
  });
});


describe('registry arrays', () => {
  it('TURN_EVALUATORS holds relationship + activity, all default-OFF', () => {
    const names = reg.TURN_EVALUATORS.map((e) => e.name);
    expect(names).toContain('relationship_eval');
    expect(names).toContain('activity_eval');
    // All turn evaluators gate to OFF by default (no flags set in this test env).
    for (const e of reg.TURN_EVALUATORS) expect(e.isEnabled()).toBe(false);
    for (const e of reg.TURN_EVALUATORS) expect(e.trigger).not.toBe('cron');
  });

  it('CRON_EVALUATORS holds the re-reach evaluator, default-OFF, cron trigger', () => {
    const names = reg.CRON_EVALUATORS.map((e) => e.name);
    expect(names).toContain('rereach_eval');
    for (const e of reg.CRON_EVALUATORS) {
      expect(e.isEnabled()).toBe(false);
      expect(e.trigger).toBe('cron');
    }
  });
});
