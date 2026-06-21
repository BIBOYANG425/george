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
import { ProfileStore, BLOCK_NAMES, BlockName } from './profile.js';
import { resolveProfileUserId } from '../db/students.js';
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

// Blocks the capturer may write to. george_notes is George's own scratchpad, not
// a place for extracted user facts, so it is excluded.
const CAPTURE_BLOCKS: BlockName[] = BLOCK_NAMES.filter((b) => b !== 'george_notes');

// salience and kind constraints mirror the user_observations DB CHECKs. The
// caller (this module) clamps salience and validates kind before insert; the
// ObservationDB seam does not.
const SALIENCE_MIN = 1;
const SALIENCE_MAX = 5;
const SALIENCE_DEFAULT = 3;
const OBSERVATION_KINDS = ['fact', 'event', 'emotion', 'preference', 'relationship'] as const;

const EXTRACT_SYSTEM = [
  "You extract two things about a student from ONE chat turn, for an AI campus companion's memory.",
  'Return STRICT JSON only: {"facts":[{"block":"<identity|academic|interests|relationships|state>","fact":"<short third-person fact>"}],"observations":[{"content":"<short third-person note>","salience":<1-5>,"kind":"<fact|event|emotion|preference|relationship>"}]}',
  'FACTS — durable, long-term things worth knowing next time:',
  '- Capture ONLY durable facts: major, year, hometown, dorm/housing, interests/hobbies, ongoing situations, relationships, stable preferences.',
  '- Do NOT capture transient chit-chat, the assistant\'s suggestions/questions, or anything the student did not clearly state.',
  '- Each fact: a short third-person statement, e.g. "studies CS, sophomore", "lives in the village", "into hiking and hotpot".',
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
  facts: Array<{ block?: string; fact?: string }>;
  observations: Array<{ content?: string; salience?: number; kind?: string }>;
}

// callLightweightLLM's non-Kimi fallback does not force JSON, so be tolerant:
// pull the first {...} object out of whatever came back. One parse, both arrays.
function parseExtract(raw: string): {
  facts: Array<{ block?: string; fact?: string }>;
  observations: RawObservation[];
} {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return { facts: [], observations: [] };
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      facts?: Array<{ block?: string; fact?: string }>;
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
  // Construct the real ObservationDB lazily — only when observe is on and no fake
  // was injected — so capture-only mode never spins up a Supabase client.
  const observationDB = observe ? deps.observationDB ?? createSupabaseObservationDB() : undefined;
  try {
    const { facts, observations } = await extractMemoryFromTurn(userText, assistantText);

    let written = 0;
    if (capture) {
      for (const f of facts) {
        const block = f.block as BlockName;
        if (!f.fact || !CAPTURE_BLOCKS.includes(block)) continue;
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

    if (written || observed) log('info', 'memory_capture', { userId, written, observed });
  } catch (err) {
    log('warn', 'memory_capture_failed', { error: (err as Error).message });
  }
}
