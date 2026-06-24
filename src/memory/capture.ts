// src/memory/capture.ts
//
// Per-turn long-term memory capture. After each conversation turn, extract any
// durable new fact the student revealed and append it to the right profile block
// via ProfileStore.appendToBlock (safe, de-duped accumulate). Runs
// fire-and-forget so it never slows the reply.
//
// Before this, a stated fact only persisted if a later heartbeat tick (~12h
// cadence, and only when HEARTBEAT_ENABLED) folded it in, or via /correct — so
// "George remembers what I just told him" did not really hold. This closes that
// latency gap by writing high-signal facts on the same turn.
//
// Gated by MEMORY_CAPTURE_ENABLED (default OFF) so it never writes to user
// profiles unless explicitly enabled (important: profiles hold real PII).
//
// P6 Observer: the SAME extraction call also emits softer, episodic
// OBSERVATIONS (mood, events, recurring patterns, relational beats) into the
// observation log via ObservationDB. Gated independently by
// GEORGE_OBSERVE_ENABLED (default OFF). With both flags unset the function is a
// no-op: no LLM call, no writes — byte-identical to the pre-P6 behavior.

import { callLightweightLLM } from '../agent/llm-providers.js';
import { ProfileStore, DURABLE_FACT_BLOCKS, BlockName } from './profile.js';
import { resolveProfileUserId, getMemoryConsent } from '../db/students.js';
import { log } from '../observability/logger.js';
import {
  embedObservation,
  createSupabaseObservationDB,
  type ObservationDB,
} from './observations.js';

export function isCaptureEnabled(): boolean {
  return process.env.MEMORY_CAPTURE_ENABLED === 'true';
}

export function isObserveEnabled(): boolean {
  return process.env.GEORGE_OBSERVE_ENABLED === 'true';
}

// Which blocks the capturer (and the update_memory tool) may write to is the
// shared DURABLE_FACT_BLOCKS allowlist from profile.ts — every block except
// george_notes (George's own scratchpad). Imported, not redefined, so capture and
// the tool can never drift apart on what's writable.

// Lightweight in-process counters so a capture run is OBSERVABLE even when it
// writes nothing or fails silently (gap A): today a swallowed error only emits a
// `warn` log the caller can't see. ok counts completed runs, failed counts
// extractor/write errors. Exported so tests (and a future metrics scrape) can read
// the failure rate instead of inferring it from logs.
export const captureMetrics = { ok: 0, failed: 0 };

// Source-grounding (anti-fabrication, code-level — mirrors the fast-path
// scanFabricationRisk philosophy): a captured fact is only persisted if its
// `quote` — the student's own words the extractor copied — actually appears in the
// STUDENT text. This drops facts the model paraphrased from GEORGE's suggestions
// or invented outright. Normalized (lowercase + collapsed whitespace) so trivial
// formatting differences don't reject a real quote; an empty/missing quote fails
// closed (not grounded → not written). Exported for direct unit testing.
export function isGroundedInStudentText(quote: string | undefined, studentText: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm(quote ?? '');
  // Reject degenerate quotes: an empty quote, or one so short it's a substring of
  // almost any text (e.g. "I", "我", "yes", "ok"). Without this floor the model
  // could attach a trivial 1-char quote to a fabricated fact and slip past the
  // substring check. <4 normalized chars carries no real evidentiary weight.
  if (q.length < 4) return false;
  return norm(studentText).includes(q);
}

// salience and kind constraints mirror the user_observations DB CHECKs. The
// caller (this module) clamps salience and validates kind before insert; the
// ObservationDB seam does not.
const SALIENCE_MIN = 1;
const SALIENCE_MAX = 5;
const SALIENCE_DEFAULT = 3;
const OBSERVATION_KINDS = ['fact', 'event', 'emotion', 'preference', 'relationship'] as const;

const EXTRACT_SYSTEM = [
  "You extract two things about a student from ONE chat turn, for an AI campus companion's memory.",
  'Return STRICT JSON only: {"facts":[{"block":"<identity|academic|interests|relationships|state>","fact":"<short third-person fact>","quote":"<the student\'s VERBATIM words proving it, copied EXACTLY from the STUDENT line>"}],"observations":[{"content":"<short third-person note>","salience":<1-5>,"kind":"<fact|event|emotion|preference|relationship>"}]}',
  'FACTS — durable, long-term things worth knowing next time:',
  '- Capture ONLY durable facts: major, year, hometown, dorm/housing, interests/hobbies, ongoing situations, relationships, stable preferences.',
  '- Do NOT capture transient chit-chat, the assistant\'s suggestions/questions, or anything the student did not clearly state.',
  '- Each fact: a short third-person statement, e.g. "studies CS, sophomore", "lives in the village", "into hiking and hotpot".',
  '- Each fact MUST carry a `quote`: the student\'s exact words it came from, copied verbatim from the STUDENT line (never from GEORGE). If you cannot quote the student verbatim, DROP that fact — facts without a real student quote are discarded.',
  '- Never invent. Only what the student actually said. If nothing durable, return "facts":[].',
  'OBSERVATIONS — only what a real friend would actually REMEMBER about this person weeks later:',
  '- Be STINGY. Most turns have NOTHING memorable. That is the normal, correct case. Default to "observations":[].',
  '- Capture ONLY: episodic events (e.g. "celebrated getting a Pear offer", "flew home for break"), emotional / state context (e.g. "stressed about CSCI 270 midterm", "homesick lately"), ongoing situations, relationships, and durable plans / preferences.',
  '- DROP, never log: greetings & acks ("said hi", "thanked you"), the act of asking a question, requests to you the bot ("asked for a like", "asked if you remember them"), meta-talk about the AI ("asked if you know who they are"), and one-off transactional chit-chat.',
  '- Short third-person, in the student\'s own language (EN or ZH). kind is one of: fact, event, emotion, preference, relationship.',
  '- salience is an integer 1-5:',
  '    1 = trivial / transactional (greeting, ack, just asking a question). DON\'T log these at 1, DROP them entirely.',
  '    2 = minor but real (a small preference or passing detail worth a faint memory).',
  '    3 = a normal memorable fact or event.',
  '    4 = significant (an emotional moment, an important plan, a relationship beat).',
  '    5 = highly memorable (a major life event).',
  '- Only log what you would genuinely want surfaced weeks later. Never invent; only what the student actually said or did. If nothing is memorable, return "observations":[].',
].join('\n');

interface RawObservation {
  content?: string;
  salience?: unknown;
  kind?: string;
}

// The shape returned by ONE Observer extraction call: durable facts +
// episodic observations. Salience stays `unknown`-ish here (number|undefined)
// because clamping happens at write time (clampSalience), not at extract time —
// both the per-turn capturer and the backfill share this raw shape and clamp
// before insert.
export interface ExtractedMemory {
  facts: Array<{ block?: string; fact?: string; quote?: string }>;
  observations: Array<{ content?: string; salience?: number; kind?: string }>;
}

// callLightweightLLM's non-Kimi fallback does not force JSON, so be tolerant:
// pull the first {...} object out of whatever came back. One parse, both arrays.
function parseExtract(raw: string): {
  facts: Array<{ block?: string; fact?: string; quote?: string }>;
  observations: RawObservation[];
} {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return { facts: [], observations: [] };
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      facts?: Array<{ block?: string; fact?: string; quote?: string }>;
      observations?: RawObservation[];
    };
    return {
      facts: Array.isArray(obj.facts) ? obj.facts : [],
      observations: Array.isArray(obj.observations) ? obj.observations : [],
    };
  } catch {
    return { facts: [], observations: [] };
  }
}

// The single Observer extraction step: ONE callLightweightLLM(EXTRACT_SYSTEM,…)
// call + parseExtract, with no env gating, no resolution, and no writes. Both
// the per-turn capturer (captureFactsFromTurn) and the offline backfill
// (scripts/backfill-observations.ts) go through this ONE code path so the
// extraction prompt + parsing never drift between the two. Callers clamp
// salience and validate kind before persisting.
export async function extractMemoryFromTurn(
  userText: string,
  assistantText: string,
): Promise<ExtractedMemory> {
  const raw = await callLightweightLLM(
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `STUDENT: ${userText}\n\nGEORGE: ${assistantText}` },
    ],
    { maxTokens: 400, jsonMode: true },
  );
  const { facts, observations } = parseExtract(raw);
  // parseExtract keeps salience as `unknown` (the raw LLM value may be a string,
  // float, or out of range); the ExtractedMemory contract narrows it to number?
  // for consumers, and both consumers re-clamp via clampSalience (which takes
  // unknown) before persisting, so the narrowing is safe at the boundary.
  return { facts, observations: observations as ExtractedMemory['observations'] };
}

// Clamp to an integer in [1,5]; default 3 if missing / NaN / out of range.
export function clampSalience(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return SALIENCE_DEFAULT;
  const floored = Math.floor(n);
  if (floored < SALIENCE_MIN) return SALIENCE_MIN;
  if (floored > SALIENCE_MAX) return SALIENCE_MAX;
  return floored;
}

// Allowed kinds map straight through; anything else (or missing) → undefined so
// the DB stores null.
export function validateKind(kind: string | undefined): string | undefined {
  return kind && (OBSERVATION_KINDS as readonly string[]).includes(kind) ? kind : undefined;
}

export async function captureFactsFromTurn(
  store: ProfileStore,
  userId: string,
  userText: string,
  assistantText: string,
  deps: { observationDB?: ObservationDB } = {},
): Promise<void> {
  const capture = isCaptureEnabled();
  const observe = isObserveEnabled();
  // Default-OFF: both flags unset → no LLM call, no resolution, no writes
  // (byte-identical to the pre-P6 early return).
  if (!capture && !observe) return;
  // user_profiles is keyed by students.user_id (uuid); userId here is the channel
  // handle. Resolve it so captured facts MERGE into the student's real profile
  // instead of failing a uuid-typed write. No onboarded student → nothing to
  // write to (the column can't hold a handle), so skip. The observation log is
  // keyed by the same uuid, so this gate applies to both paths.
  const profileKey = await resolveProfileUserId(userId);
  if (!profileKey) return;
  // PII consent gates ONLY the facts→user_profiles write. It is queried solely
  // when capture is on, and it does NOT gate the observation path (that has its
  // own GEORGE_OBSERVE_ENABLED flag) — so this never breaks an observe-only run.
  // FAIL-CLOSED via getMemoryConsent (false on any miss, incl. the not-yet-migrated
  // column). If capture is the only writer and consent is absent, there's nothing
  // left to write, so skip the extraction LLM call entirely.
  const consented = capture ? await getMemoryConsent(profileKey) : false;
  if (!observe && !consented) return;
  // Construct the real ObservationDB lazily — only when observe is on and no fake
  // was injected — so capture-only mode never spins up a Supabase client.
  const observationDB = observe ? deps.observationDB ?? createSupabaseObservationDB() : undefined;
  try {
    const { facts, observations } = await extractMemoryFromTurn(userText, assistantText);

    let written = 0;
    if (capture && consented) {
      for (const f of facts) {
        const block = f.block as BlockName;
        if (!f.fact || !DURABLE_FACT_BLOCKS.includes(block)) continue;
        // Anti-fabrication: drop any fact whose quote isn't verifiably the
        // student's own words (paraphrased-from-GEORGE or invented → discarded).
        if (!isGroundedInStudentText(f.quote, userText)) continue;
        await store.appendToBlock(profileKey, block, f.fact.trim());
        written++;
      }
    }

    let observed = 0;
    if (observe && observationDB) {
      for (const o of observations) {
        const content = o.content?.trim();
        if (!content) continue;
        const salience = clampSalience(o.salience);
        const kind = validateKind(o.kind);
        const embedding = await embedObservation(content);
        await observationDB.insert(profileKey, { content, salience, kind }, embedding);
        observed++;
      }
    }

    captureMetrics.ok++;
    // Log COUNTS only — never the raw userId (a phone number / WeChat openid is PII
    // and these logs hit stdout). Correlation, if ever needed, goes through the
    // resolved internal uuid, not the channel handle.
    if (written || observed) log('info', 'memory_capture', { written, observed });
  } catch (err) {
    captureMetrics.failed++;
    log('warn', 'memory_capture_failed', { error: (err as Error).message });
  }
}
