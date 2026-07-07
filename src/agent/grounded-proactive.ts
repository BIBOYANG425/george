// src/agent/grounded-proactive.ts
//
// P4 — grounded proactive messages (HANA pattern).
//
// A heartbeat proactive should ground in a CONCRETE open thread — a question
// george asked the user that they never answered, or a decision the user said
// they were mulling — or stay silent. Generic "event brief" pushes feel botty;
// grounding them on something the user actually left hanging feels human.
//
// The pure helpers in this module (no DB, no LLM, no clock) produce either:
//   - a list of OpenThread descriptors mined from recent messages, or
//   - a prompt note rendered append-or-empty-string (same discipline as
//     calendar-mood.ts).
// The "raised threads" dedupe ledger (so the same thread is not raised twice)
// lives in the proactive_raised_threads table, accessed through the RaisedThreadDB
// seam below.
//
// Behaviour is gated by config.groundedProactive.enabled at the call site
// (src/agent/heartbeat.ts). When the flag is unset the heartbeat user prompt is
// byte-for-byte unchanged, because the renderer returns '' and the caller only
// appends non-empty notes.

import { createServiceRoleClient } from '../memory/supabase-client.js';
import { getFlags } from '../flags.js';

export interface ProactiveMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OpenThread {
  // Stable, short key used both to dedupe against the raised-ledger and to mark
  // a thread raised. Derived deterministically from the thread's gist.
  key: string;
  // Which side left the thread open, used only to phrase the prompt note.
  source: 'george_asked' | 'user_mulling';
  // A short human-readable gist of the thread (<= 120 chars) for the prompt.
  gist: string;
}

// DEFAULT-OFF feature gate. Read from process.env at call time (same precedent
// as src/memory/capture.ts's MEMORY_CAPTURE_ENABLED) so importing this module
// never triggers config.ts's eager required-env validation. Unset / any value
// other than 'true' => disabled, and the heartbeat prompt is unchanged.
export function isGroundedProactiveEnabled(): boolean {
  return getFlags().groundedProactiveEnabled;
}

const MAX_THREADS = 3;
const GIST_MAX_CHARS = 120;

// Normalize a gist into a short stable key: lowercase, collapse whitespace,
// strip punctuation, keep the first handful of meaningful tokens. Deterministic
// so the same open thread maps to the same key across ticks.
export function threadKey(gist: string): string {
  const cleaned = gist
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').slice(0, 8).join('-').slice(0, 60);
}

function clampGist(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > GIST_MAX_CHARS
    ? `${collapsed.slice(0, GIST_MAX_CHARS - 1)}…`
    : collapsed;
}

// Heuristics for "george asked the user something and they never answered."
// We only flag a question george (assistant) asked in the LAST assistant turn
// that the user has not responded to (i.e. it is the final message, or only
// followed by other assistant messages). Pure string heuristics — no LLM.
function lastAssistantQuestion(messages: ProactiveMessage[]): string | null {
  // Find the index of the last user message; anything assistant after it is
  // unanswered. If the user never replied, the whole tail counts.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  for (let i = messages.length - 1; i > lastUserIdx; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (containsQuestion(m.content)) {
      return extractQuestionSentence(m.content);
    }
  }
  return null;
}

// A question mark in CJK or ASCII, OR a clear english/chinese decision prompt.
function containsQuestion(text: string): boolean {
  return /[?？]/.test(text);
}

// Pull the last question-bearing sentence for a tighter gist.
function extractQuestionSentence(text: string): string {
  const parts = text.split(/(?<=[?？])/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/[?？]/.test(parts[i])) return parts[i].trim();
  }
  return text;
}

// Heuristics for "the user said they were mulling a decision." Looks at the
// user's most recent message for deliberation cues in either language. Kept
// conservative: a small, explicit cue list, not sentiment.
const MULLING_CUES = [
  '纠结',
  '在考虑',
  '还在想',
  '不知道选',
  '要不要',
  '该不该',
  'deciding',
  'not sure if i should',
  'torn between',
  'debating whether',
  'trying to decide',
  'thinking about whether',
];

function lastUserMulling(messages: ProactiveMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const lower = m.content.toLowerCase();
    if (MULLING_CUES.some((cue) => lower.includes(cue) || m.content.includes(cue))) {
      return m.content;
    }
    // Only inspect the most recent user message; older deliberation is stale.
    break;
  }
  return null;
}

// Mine recent messages for concrete open threads. Pure; order: an unanswered
// george question first (highest signal it is "open"), then a user-mulled
// decision. Caps the list at MAX_THREADS.
export function extractOpenThreads(messages: ProactiveMessage[]): OpenThread[] {
  const threads: OpenThread[] = [];

  const asked = lastAssistantQuestion(messages);
  if (asked) {
    const gist = clampGist(asked);
    threads.push({ key: threadKey(gist), source: 'george_asked', gist });
  }

  const mulling = lastUserMulling(messages);
  if (mulling) {
    const gist = clampGist(mulling);
    const key = threadKey(gist);
    if (!threads.some((t) => t.key === key)) {
      threads.push({ key, source: 'user_mulling', gist });
    }
  }

  return threads.slice(0, MAX_THREADS);
}

// ── Raised-thread ledger (table-backed) ────────────────────────────────────
// The dedupe ledger (which open threads george already proactively raised, so
// he never repeats himself) lives in the proactive_raised_threads table
// (id, user_id, thread, raised_at) with a UNIQUE index on (user_id, thread).
// This seam is injected into the heartbeat so it unit-tests with a fake DB.
export interface RaisedThreadDB {
  insert(userId: string, thread: string): Promise<void>;
  list(userId: string): Promise<string[]>;
}

// Mark an open-thread key as raised for a user. Idempotent: the table's unique
// (user_id, thread) index + ignoreDuplicates make a repeat insert a no-op.
export async function recordRaisedThread(
  db: RaisedThreadDB,
  userId: string,
  key: string,
): Promise<void> {
  await db.insert(userId, key);
}

// Load the set of thread keys this user has already had raised (from the table).
export async function loadRaisedThreads(db: RaisedThreadDB, userId: string): Promise<Set<string>> {
  return new Set(await db.list(userId));
}

// Supabase-backed RaisedThreadDB. Mirrors createSupabaseProfileDB's client
// construction (service-role client, no config import) so importing this module
// never triggers config.ts's eager required-env validation.
export function createSupabaseRaisedThreadDB(): RaisedThreadDB {
  const supabase = createServiceRoleClient();
  return {
    async insert(userId, thread) {
      const { error } = await supabase
        .from('proactive_raised_threads')
        .upsert({ user_id: userId, thread }, { onConflict: 'user_id,thread', ignoreDuplicates: true });
      if (error) throw new Error(`raised-thread insert failed: ${error.message}`);
    },
    async list(userId) {
      const { data, error } = await supabase
        .from('proactive_raised_threads')
        .select('thread')
        .eq('user_id', userId);
      if (error) throw new Error(`raised-thread list failed: ${error.message}`);
      return (data ?? []).map((r: { thread: string }) => r.thread);
    },
  };
}

// Static heartbeat guidance describing HOW to use the OPEN THREADS section. This
// is part of the feature's prompt footprint, so it lives behind the DEFAULT-OFF
// flag too: heartbeat.ts appends it to the system prompt ONLY when the flag is
// on. When off, the heartbeat system prompt is byte-for-byte what it was before
// P4 (it was previously baked unconditionally into prompts/heartbeat.md — that
// was the leak this const fixes).
export const GROUNDED_PROACTIVE_GUIDANCE = [
  '## Grounding a proactive in an open thread',
  '',
  'A good unprompted message lands on something real that the user actually left hanging. A generic "here\'s what\'s happening this week" brief reads like a bot, so don\'t send one.',
  '',
  'When an `# OPEN THREADS (grounded proactive)` section is present in your context, it lists concrete open threads — a question you asked that they never answered, or a decision they told you they were mulling. If you send a proactive this tick, ground it in ONE of those threads, phrased in your own voice as if you simply remember it (e.g. "想好选 BUAD 280 还是等下学期了吗" if they were torn on that). Don\'t pick more than one thread; don\'t stack them.',
  '',
  'If none of the listed threads still feels worth reaching out about — or there\'s no `# OPEN THREADS` section at all and you\'d just be sending a generic check-in — prefer `heartbeat_ok()` and stay silent. A pending followup that is due now is still a valid reason to send even without an open thread; that path is unchanged.',
].join('\n');

// Filter to threads not yet raised.
export function unraisedThreads(threads: OpenThread[], raised: Set<string>): OpenThread[] {
  return threads.filter((t) => !raised.has(t.key));
}

// Render the grounded-proactive prompt note, or '' when there is nothing fresh
// to ground on. Callers append unconditionally; an empty string adds nothing
// (same append-or-empty-string discipline as renderMoodBlock). When empty, the
// heartbeat prompt is identical to before this feature existed.
export function renderGroundedProactiveNote(threads: OpenThread[]): string {
  if (threads.length === 0) return '';
  const lines = threads.map((t) => {
    const label = t.source === 'george_asked' ? 'you asked, no reply yet' : 'they were mulling';
    return `- (${label}) ${t.gist}`;
  });
  return [
    '# OPEN THREADS (grounded proactive)',
    'If — and ONLY if — you decide a proactive message is warranted this tick, it MUST',
    'ground in ONE of these concrete open threads. Reference the actual thing, in your',
    'own voice, the way you would simply remember it. If none of these still feels worth',
    'reaching out about, send nothing (prefer heartbeat_ok over a generic check-in).',
    ...lines,
  ].join('\n');
}
