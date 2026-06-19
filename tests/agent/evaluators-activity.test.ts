// tests/agent/evaluators-activity.test.ts
//
// Unit tests for the pure activity evaluator wrapper. Asserts kind==='pure',
// run() is inert (no DB / LLM, no side effect), and isEnabled tracks the
// SAME GEORGE_ACTIVITY_STATE_ENABLED flag activity-state.ts reads (no new flag).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { activityEvaluator } from '../../src/agent/evaluators/activity.js';

const FLAG = 'GEORGE_ACTIVITY_STATE_ENABLED';

describe('activityEvaluator', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env[FLAG]; });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('is a pure, turn-trigger evaluator', () => {
    expect(activityEvaluator.name).toBe('activity_eval');
    expect(activityEvaluator.kind).toBe('pure');
    expect(activityEvaluator.trigger).toBe('turn');
  });

  it('isEnabled tracks the existing GEORGE_ACTIVITY_STATE_ENABLED flag', () => {
    delete process.env[FLAG];
    expect(activityEvaluator.isEnabled()).toBe(false);
    process.env[FLAG] = 'true';
    expect(activityEvaluator.isEnabled()).toBe(true);
    process.env[FLAG] = '1'; // only the exact string "true" enables
    expect(activityEvaluator.isEnabled()).toBe(false);
  });

  it('shouldRun is true only when there is an active phase overlay', () => {
    // 04:00 LA -> sleeping phase (overlay present).
    expect(activityEvaluator.shouldRun({ trigger: 'turn', now: new Date('2026-06-15T04:00:00-07:00') })).toBe(true);
    // Mid-day awake stretch -> getActivityState returns null -> no overlay.
    expect(activityEvaluator.shouldRun({ trigger: 'turn', now: new Date('2026-06-15T16:30:00-07:00') })).toBe(false);
  });

  it('run() is inert: resolves with no value and makes no call', async () => {
    // No stores supplied; an inert run() must not touch them or throw.
    await expect(activityEvaluator.run({ trigger: 'turn' })).resolves.toBeUndefined();
  });
});
