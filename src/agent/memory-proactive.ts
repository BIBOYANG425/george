// src/agent/memory-proactive.ts
//
// P6 (post-MVP) — proactive MEMORY-grounding for the heartbeat.
//
// The reactive complement (Recall, src/memory/recall.ts) injects remembered
// observations into a REPLY when the user pings George. This is the PROACTIVE
// complement: it surfaces recent, salient observations the student told George
// as candidate material the heartbeat can warmly check in about unprompted
// ("hey, how'd that CSCI 270 final go?"). It only SUPPLIES grounding — the model
// still DECIDES whether to send (it can heartbeat_ok), and every send still flows
// through the existing send_proactive_message consent / cadence / quiet-hour
// gates. We add candidate material, we never add a second send mechanism.
//
// This is the memory sibling of grounded-proactive.ts (the open-thread grounding
// source). It is ADDITIVE: open-thread grounding and memory grounding are
// independent sources behind independent flags, rendered into separate prompt
// sections.
//
// Behaviour is gated by GEORGE_MEMORY_PROACTIVE_ENABLED at the call site
// (src/agent/heartbeat.ts). When the flag is unset:
//   - the observation DB is never touched (no extra load), and
//   - the renderer returns '' so the user prompt is byte-for-byte unchanged,
//   - the guidance is not appended so the system prompt is byte-for-byte unchanged.
//
// Dedup (no new migration): reuses the proactive_raised_threads table through the
// same RaisedThreadDB seam grounded-proactive.ts uses. Each candidate observation
// maps to a stable key `mem:<id>` (disjoint from open-thread keys, which are gist
// slugs). Already-raised keys are excluded from the candidate set; when a proactive
// is actually sent that tick, the surfaced candidates' keys are recorded so a
// remembered observation is never raised twice.

import type { UnconsolidatedObservation } from '../memory/observations.js';
import { getFlags } from '../flags.js';

// DEFAULT-OFF feature gate. Read from process.env at call time (same precedent as
// isGroundedProactiveEnabled / isRecallEnabled) so importing this module never
// triggers config.ts's eager required-env validation. Unset / any value other
// than 'true' => disabled, and the heartbeat prompt is unchanged.
export function isMemoryProactiveEnabled(): boolean {
  return getFlags().memoryProactiveEnabled;
}

// Higher salience bar than per-turn Recall (RECALL_MIN_SALIENCE default 2): an
// UNPROMPTED check-in should land on something genuinely worth reaching out about,
// so the default floor is 3. Overridable via MEMORY_PROACTIVE_MIN_SALIENCE.
const MIN_SALIENCE_DEFAULT = 3;
const MIN_SALIENCE_FLOOR = 1;
const MIN_SALIENCE_CEIL = 5;

// How many recent salient observations to load, and how many to actually surface
// as candidates in the prompt (keep it lean — a check-in grounds on ONE memory).
export const MEMORY_PROACTIVE_LOAD_LIMIT = 10;
const MAX_CANDIDATES = 3;

// Parse an int env var, falling back to `fallback` on missing / NaN. Mirrors the
// finite-checked parseIntEnv in recall.ts / heartbeat.ts so a valid 0 is honored.
function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// Min-salience floor for proactive memory grounding. Clamped to the DB's 1..5
// CHECK range, default 3 (higher bar than reactive recall).
export function resolveMemoryProactiveMinSalience(): number {
  const n = parseIntEnv(process.env.MEMORY_PROACTIVE_MIN_SALIENCE, MIN_SALIENCE_DEFAULT);
  return Math.min(MIN_SALIENCE_CEIL, Math.max(MIN_SALIENCE_FLOOR, n));
}

// A candidate memory George could warmly check in about, plus its stable dedup key.
export interface MemoryCandidate {
  // Stable dedup key in the proactive_raised_threads ledger. `mem:<observation id>`
  // is disjoint from open-thread keys (which are gist slugs), so the two grounding
  // sources share the table without colliding.
  key: string;
  content: string;
}

// Derive the stable raised-ledger key for an observation. Deterministic, so the
// same observation maps to the same key across ticks regardless of its content.
export function memoryKey(observationId: number): string {
  return `mem:${observationId}`;
}

// Turn loaded observations into candidate check-ins, dropping any already raised.
// Pure (no DB, no LLM, no clock): the caller loads observations + the raised set
// and passes them in. Caps the list at MAX_CANDIDATES (a check-in grounds on one
// memory; we surface a few so the model can pick the most apt).
export function selectMemoryCandidates(
  observations: UnconsolidatedObservation[],
  raised: Set<string>,
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  for (const o of observations) {
    const key = memoryKey(o.id);
    if (raised.has(key)) continue;
    const content = (o.content ?? '').trim();
    if (!content) continue;
    out.push({ key, content });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// Render the memory-grounding prompt note, or '' when there is nothing fresh to
// check in about. Callers append unconditionally; an empty string adds nothing
// (same append-or-empty-string discipline as renderGroundedProactiveNote). When
// empty, the heartbeat prompt is identical to before this feature existed.
export function renderMemoryProactiveNote(candidates: MemoryCandidate[]): string {
  if (candidates.length === 0) return '';
  const lines = candidates.map((c) => `- ${c.content}`);
  return [
    '# MEMORIES TO CHECK IN ON (proactive memory-grounding)',
    'If — and ONLY if — you decide a proactive message is warranted this tick, you may',
    'ground it in ONE of these things the student told you earlier, phrased in your own',
    "voice as if you simply remember it (e.g. \"上次说 CSCI 270 final 快把你整死了，考得咋样😋\").",
    'Reference the actual thing; do not stack more than one. If none of these still feels',
    'worth reaching out about, send nothing (prefer heartbeat_ok over a generic check-in).',
    ...lines,
  ].join('\n');
}

// Static heartbeat guidance describing HOW to use the MEMORIES section. Part of
// the feature's prompt footprint, so it lives behind the DEFAULT-OFF flag too:
// heartbeat.ts appends it to the system prompt ONLY when the flag is on. When off,
// the heartbeat system prompt is byte-for-byte unchanged.
export const MEMORY_PROACTIVE_GUIDANCE = [
  '## Checking in on a remembered observation',
  '',
  "A warm unprompted check-in lands when it references something the student actually told you — a final they were stressed about, a trip they were excited for, a friend drama they vented about. A generic \"how's it going\" reads like a bot, so don't send one.",
  '',
  'When a `# MEMORIES TO CHECK IN ON` section is present in your context, it lists recent, salient things the student shared. If you send a proactive this tick, you may ground it in ONE of those memories, phrased in your own voice as if you simply remember it. Pick at most one; do not stack memories, and do not combine a memory with an open thread in the same message.',
  '',
  'If none of the listed memories still feels worth reaching out about — or there is no such section at all — prefer `heartbeat_ok()` and stay silent. A pending followup due now is still a valid reason to send on its own; that path is unchanged.',
].join('\n');
