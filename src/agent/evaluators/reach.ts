// src/agent/evaluators/reach.ts
//
// Re-reach evaluator (NEW, flag-gated default-OFF via SQUAD_REREACH_EVAL_ENABLED).
// Generalizes the squad-coordinator's "you said you'd decide / haven't heard
// from you" nudge for STALLED candidates WITHOUT touching squad-coordinator.ts
// or any of its deps, queries, or stamps. Mirrors relationship.ts's structure
// (isEnabled / shouldRun pure cadence / run fire-and-forget) and owns its OWN
// ReachEvalDeps DI interface (like HeartbeatDeps).
//
// Hard separation from the live coordinator:
//  - its OWN candidate query (selectReachCandidates), NOT selectWebInterest /
//    Reminders / Refills / Completions
//  - its OWN dedup stamp (markReached / alreadyReached) that does NOT write
//    brokered_at / reminder_sent_at / completed_at / needs_refill — so the
//    coordinator's idempotency is untouched
//  - cron trigger only ('both' off)
//
// Candidacy is PURE (shouldReachCandidate) and separate from any LLM tone
// rewrite, so it unit-tests without the API. The bubble is a grounded George-
// voice template (no invented event/decision content). A tone variant keyed off
// the relationship note is the only LLM path and runs through the voice hard-bans
// (no em-dash / negation-contrast) before send; if a banned tell appears, we fall
// back to the safe template. The spectrum send seam (getActiveSpectrumClient().sendProactive)
// is reused via the deps; cron IS the retry mechanism (a failed send leaves the
// candidate un-stamped for the next tick).
//
// Gated by SQUAD_REREACH_EVAL_ENABLED (default OFF). When unset this never runs,
// never queries, never sends — behavior is byte-for-byte unchanged.

import type { Evaluator, EvalContext } from './types.js';
import { getFlags } from '../../flags.js';
import { log } from '../../observability/logger.js';
import { bannedVoiceHits } from '../voice-guard.js';

export function isReachEvalEnabled(): boolean {
  return getFlags().squadRereachEvalEnabled;
}

// Staleness threshold in hours. Default deliberately past the coordinator's 24h
// reminder window so a re-reach never races a live coordinator reminder. Read
// only when enabled.
export const REREACH_STALE_HOURS_DEFAULT = 48;

export function reachStaleHours(): number {
  const raw = process.env.SQUAD_REREACH_STALE_HOURS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : REREACH_STALE_HOURS_DEFAULT;
}

// A stalled candidate: a post/user pair that went quiet. The query (in
// reach-eval-deps.ts) is responsible for joining the post + the user handle;
// this engine only decides candidacy and composes the nudge.
export interface ReachCandidate {
  // Stable id for the dedup stamp (the post id this re-reach is about).
  postId: string;
  // The student to re-reach, already resolved by the query.
  studentId: string;
  // Grounded display fields for the template (never invented — sourced from the
  // post row by the query).
  posterName: string;
  category: string;
  location: string | null;
  // ISO timestamp of the last activity on this candidate (created_at or last
  // touch). Used by the pure staleness gate.
  lastActivityAt: string;
}

// PURE candidacy gate. A candidate is stalled when its last activity is older
// than the threshold. Completed / already-reached filtering is handled by the
// query + the per-candidate alreadyReached dedup check inside run(), keeping
// this function a pure time comparison that unit-tests with no IO.
export function shouldReachCandidate(
  candidate: ReachCandidate,
  now: Date = new Date(),
  staleHours: number = reachStaleHours(),
): boolean {
  const last = new Date(candidate.lastActivityAt).getTime();
  if (!Number.isFinite(last)) return false;
  const ageMs = now.getTime() - last;
  return ageMs >= staleHours * 3600_000;
}

const loc = (l: string | null) => (l ? ` ${l}` : '');

// Grounded George-voice template (no banned phrases, no invented content). Same
// register as the coordinator bubbles. Pure — needs no lint.
export function reachBubble(category: string, location: string | null): string {
  return `诶 之前那个${category}局${loc(location)} 还在想吗? 有兴趣的话回我一声哈`;
}

// Deps for the engine. DI like HeartbeatDeps: nothing is a module global.
export interface ReachEvalDeps {
  // NEW query: stalled, not-completed, not-yet-reached candidates. NOT the
  // coordinator's four selects.
  selectReachCandidates: () => Promise<ReachCandidate[]>;
  // Resolve a student id to an iMessage handle (reuse the coordinator's
  // signature; a fresh implementation, not the coordinator's instance).
  handleFor: (studentId: string) => Promise<string | null>;
  // Proactive send seam (reuses getActiveSpectrumClient().sendProactive).
  sendProactive: (handle: string, bubbles: string[]) => Promise<void>;
  // NEW dedup stamp. Does NOT write brokered_at / reminder_sent_at /
  // completed_at / needs_refill.
  markReached: (postId: string, studentId: string) => Promise<void>;
  alreadyReached: (postId: string, studentId: string) => Promise<boolean>;
  now?: () => Date;
  staleHours?: () => number;
  // Optional tone-variant composer keyed off the relationship note. When
  // provided AND it returns a non-empty, lint-clean string, it replaces the
  // template bubble; otherwise the safe template is used.
  composeTone?: (candidate: ReachCandidate) => Promise<string | null>;
}

// Fire-and-forget engine. Iterates its own candidates, dedups per candidate,
// composes (template or lint-checked tone variant), sends, then stamps ONLY on
// a successful send. NEVER throws into the caller (the dispatcher also guards).
export async function runReachEval(deps: ReachEvalDeps): Promise<void> {
  if (!isReachEvalEnabled()) return;
  const now = deps.now ? deps.now() : new Date();
  const staleHours = deps.staleHours ? deps.staleHours() : reachStaleHours();
  let candidates: ReachCandidate[];
  try {
    candidates = await deps.selectReachCandidates();
  } catch (err) {
    log('warn', 'rereach_eval_query_failed', { error: (err as Error).message });
    return;
  }
  for (const c of candidates) {
    try {
      if (!shouldReachCandidate(c, now, staleHours)) continue;
      if (await deps.alreadyReached(c.postId, c.studentId)) continue;
      const handle = await deps.handleFor(c.studentId);
      if (!handle) continue;
      const bubble = await composeReachBubble(deps, c);
      await deps.sendProactive(handle, [bubble]);
      // Stamp ONLY after a successful send (a failed send retries next tick —
      // cron IS the retry mechanism).
      await deps.markReached(c.postId, c.studentId);
    } catch (err) {
      // Skip this candidate; leave it un-stamped so the next tick retries.
      log('warn', 'rereach_eval_candidate_failed', { postId: c.postId, error: (err as Error).message });
    }
  }
}

// Pick the outgoing bubble: a tone variant when the optional composer yields one
// that passes the voice hard-bans (no em-dash, no negation-contrast), otherwise
// the safe grounded template. The variant is the only LLM path; a banned tell or a
// throw falls back to the template (anti-fabrication / voice safety preserved).
async function composeReachBubble(deps: ReachEvalDeps, c: ReachCandidate): Promise<string> {
  const fallback = reachBubble(c.category, c.location);
  if (!deps.composeTone) return fallback;
  try {
    const variant = await deps.composeTone(c);
    if (!variant) return fallback;
    const trimmed = variant.trim();
    if (!trimmed) return fallback;
    const banned = bannedVoiceHits(trimmed);
    if (banned.length) {
      log('warn', 'rereach_eval_tone_banned', { postId: c.postId, hits: banned });
      return fallback;
    }
    return trimmed;
  } catch (err) {
    log('warn', 'rereach_eval_tone_failed', { postId: c.postId, error: (err as Error).message });
    return fallback;
  }
}

// ── Evaluator adapter ───────────────────────────────────────────────────
// cron-only. The engine iterates its own candidate set internally, so the cron
// ctx is thin ({now, trigger:'cron'}) and the real deps are captured in the
// closure here (constructed once in index.ts via buildReachEvalDeps).
//
// The adapter exposes a setter so index.ts can inject the real deps when the
// flag is on (and tests can inject mocks) without a module global at import
// time. Until deps are set, run() is a no-op (it also no-ops when the flag is
// off, so an unconfigured registry is harmless).
let reachDeps: ReachEvalDeps | null = null;

export function setReachEvalDeps(deps: ReachEvalDeps | null): void {
  reachDeps = deps;
}

export const reachEvaluator: Evaluator = {
  name: 'rereach_eval',
  kind: 'llm',
  trigger: 'cron',
  isEnabled: isReachEvalEnabled,
  // The pure per-candidate staleness gate lives in shouldReachCandidate; at the
  // dispatch level there is always work to consider when enabled (the engine
  // filters internally), so shouldRun just confirms deps are wired.
  shouldRun: (): boolean => reachDeps !== null,
  run: async (): Promise<void> => {
    if (!reachDeps) return;
    await runReachEval(reachDeps);
  },
};
