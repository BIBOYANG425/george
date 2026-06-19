// src/agent/evaluators/types.ts
//
// Shared "Evaluator" contract for George's background brain. An evaluator is a
// flag-gated, fire-and-forget side task that runs off a user turn or a cron
// tick (relationship-note rewrite, activity-phase telemetry, stalled-post
// re-reach). It is the formalization of the fire-and-forget blocks that
// relationship.ts and capture.ts hand-roll today.
//
// DI mirrors HeartbeatDeps: stores flow through EvalContext, not module-level
// singletons; anything heavier (DB queries, the Spectrum send seam) is captured
// in a per-evaluator constructor closure (see reach.ts / reach-eval-deps.ts).
//
// Heterogeneous on purpose: outputs differ (prose vs no-LLM vs proactive send),
// so this is a COMPOSITION contract, not a unification. `kind` documents cost
// ('pure' never calls a model); `trigger` declares where the dispatcher may run
// it; isEnabled() gates on a per-evaluator env flag (default OFF, exactly the
// GEORGE_*_ENABLED / SQUAD_*_ENABLED pattern); shouldRun() is the pure cadence
// gate (unit-testable without an LLM); run() never throws.
//
// The single fire-and-forget choke point is runEvaluatorSafely() in registry.ts
// — individual run() bodies keep their own internal try/catch for partial work,
// but the dispatcher guarantees the caller never sees a throw.

import type { SessionStore } from '../session-store.js';
import type { ProfileStore } from '../../memory/profile.js';

// Where an evaluator is eligible to run. 'both' means a turn OR a cron tick may
// dispatch it; the dispatcher still consults trigger to decide eligibility per
// list (TURN_EVALUATORS vs CRON_EVALUATORS).
export type EvaluatorTrigger = 'turn' | 'cron' | 'both';

// Cost class. 'pure' MUST never call a model (cheap, telemetry-safe); 'llm' may.
export type EvaluatorKind = 'pure' | 'llm';

// Per-dispatch context. Stores are optional so a thin cron ctx (only {now,
// trigger}) is valid — cron evaluators capture their own deps in a closure.
export interface EvalContext {
  // The user this dispatch is for. Empty string for cron evaluators that iterate
  // their own candidate set internally (re-reach), where there is no single user.
  userId?: string;
  // Defaults to new Date() at the call site; pure classifiers read it.
  now?: Date;
  // Conversation history seam (turn evaluators).
  sessionStore?: SessionStore;
  // Memory blocks seam (turn evaluators).
  profileStore?: ProfileStore;
  // CUMULATIVE user-message count (NOT the recent 20-cap window). Sourced from
  // sessionStore.countUserMessages so cadence ("every Nth message") keeps
  // advancing instead of plateauing. Populated by the per-turn hook.
  userMessageCount?: number;
  // Wall-clock ms of George's last reply to this user, for gap-aware logic.
  lastReplyAt?: number;
  // What kind of dispatch this is.
  trigger: 'turn' | 'cron';
}

export interface Evaluator {
  // Stable log key, e.g. 'relationship_eval', 'activity_eval', 'rereach_eval'.
  // Used as the structured-log event prefix so the dashboard sees every
  // evaluator uniformly (`${name}` on success, `${name}_failed` on error).
  name: string;
  // Documents cost; 'pure' never calls a model.
  kind: EvaluatorKind;
  // Env-flag gate (default OFF). Exactly the GEORGE_*_ENABLED / SQUAD_*_ENABLED
  // pattern. When false, runEvaluatorSafely returns before any IO.
  isEnabled(): boolean;
  // Where the dispatcher may run this evaluator.
  trigger: EvaluatorTrigger;
  // Pure-where-possible cadence/gate. Unit-testable without an LLM. May be async
  // for evaluators whose cadence needs an IO read, but prefer pure.
  shouldRun(ctx: EvalContext): boolean | Promise<boolean>;
  // Do the work. MUST NOT throw into the caller — internal try/catch for partial
  // work, and the dispatcher adds a final safety net regardless.
  run(ctx: EvalContext): Promise<void>;
}
