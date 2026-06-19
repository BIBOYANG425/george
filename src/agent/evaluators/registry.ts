// src/agent/evaluators/registry.ts
//
// The two dispatch paths (per-turn in spectrum.ts, per-cron in index.ts) share
// ONE registry and ONE safety helper. This is the only place that swallows an
// evaluator throw — individual run() bodies keep their own try/catch for partial
// work, but runEvaluatorSafely is the choke point that guarantees the caller
// (a user-facing reply path or a cron tick) never sees an exception and never
// pays latency for the side task.
//
// The registry is the home ONLY for the turn evaluators + the new cron re-reach
// evaluator. The live heartbeat scheduler and squad-coordinator keep their
// existing entry points and are NOT moved here, so this change never risks the
// live heartbeat tick timing or the live coordinator dispatch.

import type { Evaluator, EvalContext } from './types.js';
import { log } from '../../observability/logger.js';
import { relationshipEvaluator } from './relationship.js';
import { activityEvaluator } from './activity.js';
import { reachEvaluator } from './reach.js';

// Run one evaluator with the full fire-and-forget contract: gate on isEnabled,
// then the pure shouldRun cadence, then run() inside a try/catch that logs and
// swallows. Returns void; NEVER throws. Telemetry uses the evaluator's stable
// name so the dashboard sees all evaluators with consistent keys.
export async function runEvaluatorSafely(ev: Evaluator, ctx: EvalContext): Promise<void> {
  try {
    if (!ev.isEnabled()) return;
    if (!(await ev.shouldRun(ctx))) return;
    await ev.run(ctx);
    log('info', ev.name, { userId: ctx.userId });
  } catch (err) {
    log('warn', `${ev.name}_failed`, { userId: ctx.userId, error: (err as Error).message });
  }
}

// Fire every evaluator in the list (each already gated inside runEvaluatorSafely)
// concurrently and wait for all to settle. NEVER throws — Promise.allSettled
// absorbs any straggler rejection that escaped a misbehaving evaluator. Callers
// `void` this on user-facing paths so it never adds latency to the reply.
export async function dispatchEvaluators(list: Evaluator[], ctx: EvalContext): Promise<void> {
  await Promise.allSettled(list.map((ev) => runEvaluatorSafely(ev, ctx)));
}

// Turn-dispatched evaluators (run after a user turn is persisted). Both default
// OFF, so with no flags set dispatchEvaluators is a no-op loop.
export const TURN_EVALUATORS: Evaluator[] = [relationshipEvaluator, activityEvaluator];

// Cron-dispatched evaluators (run on the re-reach cron block in index.ts).
// Default OFF; the cron block itself is only registered when the flag is on.
export const CRON_EVALUATORS: Evaluator[] = [reachEvaluator];
