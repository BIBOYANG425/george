// src/agent/evaluators/activity.ts
//
// Pure-evaluator wrapper over activity-state.ts. activity-state.ts is already
// the canonical pure evaluator (getActivityState returns state|null,
// renderActivityBlock returns ''|block, injected by the orchestrator). This
// formalizes it as a registry member for the dispatcher / observability story
// WITHOUT adding a second injection point or any DB write.
//
// run() is intentionally INERT: the activity block is rendered in the prompt
// path (buildOrchestratorPrompt), which remains the byte-for-byte source of
// truth. The evaluator's value is (a) it documents the pure-evaluator template,
// and (b) the cron/turn dispatcher can log the activity phase for telemetry
// without any model cost.
//
// Gate is IDENTICAL to activity-state.ts (the same GEORGE_ACTIVITY_STATE_ENABLED
// flag) — no new flag. When the flag is off, isEnabled() is false so the
// dispatcher returns before run(), and nothing changes.

import type { Evaluator, EvalContext } from './types.js';
import { getActivityState } from '../activity-state.js';

export const activityEvaluator: Evaluator = {
  name: 'activity_eval',
  kind: 'pure',
  trigger: 'turn',
  // Reuses the SAME flag activity-state.ts reads — no second flag, no drift.
  isEnabled: (): boolean => process.env.GEORGE_ACTIVITY_STATE_ENABLED === 'true',
  // Pure cadence: only "runs" (logs) when there's an active phase overlay.
  shouldRun: (ctx: EvalContext): boolean => getActivityState(ctx.now) !== null,
  // Inert by design — the prompt path already renders the block. No LLM, no DB.
  run: async (): Promise<void> => {},
};
