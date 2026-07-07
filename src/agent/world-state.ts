// src/agent/world-state.ts
//
// "World Info" timed-state (HANA P5). A lightweight, in-process layer that
// notices when a student is living through a charged situation — visa stress,
// finals, homesickness, an internship hunt — and keeps a short "sticky note"
// about it warm for a few turns so George stays attuned to it across the
// conversation, then lets it cool down on its own.
//
// This is the same append-or-empty-string injection mechanism as
// calendar-mood.ts (renderMoodBlock), but per-user and driven by what the
// student actually says rather than the date. The calendar overlay sets the
// macro tone (it's finals season for EVERYONE); world-state sets the micro tone
// (THIS student just said their visa got stuck).
//
// Storage is an ephemeral in-process Map keyed by userId. NO DB, NO schema, NO
// PII at rest beyond the running process — a restart clears it, which is fine:
// these are transient emotional weather, not memory. Durable facts still belong
// in the 6-block profile (src/memory/profile.ts).
//
// The whole module is pure given an injected clock (the `turn` counter), so the
// detection + decay + render core unit-tests with zero LLM calls. It is gated
// behind WORLD_STATE_ENABLED and is never invoked when that flag is unset, so
// behavior is byte-for-byte unchanged by default.

// A single world-state topic: the trigger keywords that warm it and the
// in-voice note George should keep in mind while it is warm.
import { getFlags } from '../flags.js';

export interface WorldTopic {
  key: string;
  // Lowercased keywords (any language) that, when seen in a user message, warm
  // this topic. ASCII keywords are matched on word boundaries (so 'opt' fires on
  // "opt" but not "options"/"laptop"); CJK keywords fall back to substring. See
  // triggerMatches().
  triggers: string[];
  // The sticky note injected into the prompt while the topic is warm. This is
  // GUIDANCE on attunement only — it never overrides master.md's voice or the
  // anti-fabrication rules, and it must not invent facts. Phrased as "if it
  // comes up" so George never forces the subject.
  note: string;
}

// The table of topics George keeps an ear out for. Deliberately small and
// high-signal — these are the recurring heavy moments for USC international
// students, drawn from AGENT.md's pain points (visa, finals, housing, the
// offer/internship grind, homesickness). Tune the trigger lists freely; they
// are matched case-insensitively, on word boundaries for ASCII and as substrings
// for CJK (see triggerMatches).
export const WORLD_TOPICS: WorldTopic[] = [
  {
    key: 'visa',
    triggers: ['visa', 'f-1', 'f1', 'opt', 'cpt', 'i-20', 'i20', 'sevis', 'uscis', '签证', '身份', '小黑屋', 'rfe', 'h1b', 'h-1b'],
    note: 'This student has visa / immigration status on their mind. It is a real, high-stakes stressor for international students. If it comes up, be calm, concrete, and steady — never breezy. Do not invent legal facts, dates, or procedures; if you do not know, say so and point them at OIS / a real advisor.',
  },
  {
    key: 'finals',
    triggers: ['finals', 'final exam', 'midterm', '期末', '考试周', 'deadline', 'due tonight', 'all nighter', 'all-nighter', '通宵', 'cramming'],
    note: 'This student is in a crunch (finals / midterms / a deadline). Be terse and useful — fast answers, no chit-chat, no profile nudges. Meet the stress with steadiness, not energy.',
  },
  {
    key: 'homesick',
    triggers: ['homesick', 'miss home', 'miss my family', 'miss my mom', 'miss my parents', '想家', '想回家', '孤独', 'lonely', 'so alone', 'no friends here'],
    note: 'This student sounded homesick / lonely. Sit with it — match the feeling before fixing anything. A small concrete suggestion (a meal, a low-key BIA thing, someone to text) lands better than a pep talk. Never minimize it.',
  },
  {
    key: 'job-hunt',
    triggers: ['internship', 'job hunt', 'recruiting', 'interview', 'offer', 'rejected', 'rejection', 'leetcode', 'oa', 'online assessment', '面试', '实习', '找工作', '秋招', '春招', 'networking'],
    note: 'This student is in the internship / job grind. It is exhausting and ego-bruising. Be a real one — practical, encouraging, no toxic positivity. Specific next steps beat "你可以的". Never invent a company, deadline, or referral.',
  },
];

// How many turns a topic stays warm after it was last triggered, before it
// cools off and stops being injected. One full conversation's worth — long
// enough to carry across a few exchanges, short enough that it fades when the
// student has clearly moved on.
export const DEFAULT_WARM_TURNS = 5;

// One warm topic for one user: which topic, and the turn index it expires at.
interface WarmEntry {
  key: string;
  expiresAtTurn: number;
}

// Match one trigger against an already-lowercased message.
//   - CJK / non-ASCII triggers have no word boundaries, so they match as plain
//     substrings (签证, 想家).
//   - ASCII triggers always require a LEFT boundary, so 'opt' never fires inside
//     'adopt' / 'laptop'.
//   - SHORT acronym-like ASCII triggers (<=3 alnum chars: opt, cpt, oa, f1, rfe,
//     i20, h1b) ALSO require a RIGHT boundary, so 'opt' doesn't fire on 'options'.
//     Longer word triggers stay open on the right so normal inflections still
//     match ('offer' -> 'offers', 'internship' -> 'internships').
function triggerMatches(lowerText: string, rawKw: string): boolean {
  const kw = rawKw.trim().toLowerCase();
  if (!kw) return false;
  if (/[^\x00-\x7f]/.test(kw)) return lowerText.includes(kw);
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^[a-z0-9]/.test(kw) ? '(?<![a-z0-9])' : '';
  const isShort = kw.replace(/[^a-z0-9]/g, '').length <= 3;
  const right = isShort && /[a-z0-9]$/.test(kw) ? '(?![a-z0-9])' : '';
  return new RegExp(`${left}${esc}${right}`).test(lowerText);
}

// Pure: which topic keys does this message trigger? See triggerMatches for the
// boundary rules. Returns a de-duplicated, table-ordered list so the output is
// deterministic.
export function detectTriggers(text: string, topics: WorldTopic[] = WORLD_TOPICS): string[] {
  const lower = text.toLowerCase();
  return topics.filter((t) => t.triggers.some((kw) => triggerMatches(lower, kw))).map((t) => t.key);
}

// Pure: render the active topics as a prompt section, or '' when none are warm,
// so callers can append unconditionally (same contract as renderMoodBlock).
// `keys` are topic keys in priority order; unknown keys are skipped.
export function renderWorldStateBlock(keys: string[], topics: WorldTopic[] = WORLD_TOPICS): string {
  if (keys.length === 0) return '';
  const notes = keys
    .map((k) => topics.find((t) => t.key === k))
    .filter((t): t is WorldTopic => Boolean(t))
    .map((t) => `- ${t.note}`);
  if (notes.length === 0) return '';
  return [
    '# WHAT THIS STUDENT IS CARRYING RIGHT NOW',
    'Recent context this student raised. Stay quietly attuned to it — weave it in',
    "only if it fits, never force the subject. This is tone guidance, not a script,",
    'and it never overrides your voice rules or the no-invented-facts rule.',
    ...notes,
  ].join('\n');
}

// Ephemeral per-user store of warm topics. In-process Map only; cleared on
// restart by design. A simple monotonic turn counter per user drives decay, so
// the whole thing is deterministic and testable without timers or a real clock.
export class WorldStateStore {
  private readonly users = new Map<string, { turn: number; warm: Map<string, WarmEntry> }>();
  private readonly warmTurns: number;
  private readonly topics: WorldTopic[];

  constructor(opts: { warmTurns?: number; topics?: WorldTopic[] } = {}) {
    this.warmTurns = opts.warmTurns ?? DEFAULT_WARM_TURNS;
    this.topics = opts.topics ?? WORLD_TOPICS;
  }

  // Record one user turn: advance this user's turn counter, warm any topics the
  // message triggers, and expire any that have cooled. Returns the topic keys
  // that are warm AFTER this turn, in table (priority) order. Pure w.r.t. the
  // internal counter — no wall-clock, no I/O.
  observe(userId: string, text: string): string[] {
    const state = this.users.get(userId) ?? { turn: 0, warm: new Map<string, WarmEntry>() };
    state.turn += 1;

    // Warm (or re-warm) every triggered topic to expire warmTurns from now.
    for (const key of detectTriggers(text, this.topics)) {
      state.warm.set(key, { key, expiresAtTurn: state.turn + this.warmTurns });
    }

    // Cool off anything past its window.
    for (const [key, entry] of state.warm) {
      if (entry.expiresAtTurn <= state.turn) state.warm.delete(key);
    }

    this.users.set(userId, state);
    return this.activeKeys(state);
  }

  // The topic keys currently warm for a user, in table order, WITHOUT advancing
  // the turn counter. (observe() already returns this; getActive is for read-only
  // callers.) Returns [] for an unknown user.
  getActive(userId: string): string[] {
    const state = this.users.get(userId);
    if (!state) return [];
    return this.activeKeys(state);
  }

  // Render the active world-state block for a user, or '' when nothing is warm.
  render(userId: string): string {
    return renderWorldStateBlock(this.getActive(userId), this.topics);
  }

  // Drop a user's state entirely (e.g. on `/delete me`). No-op if absent.
  clear(userId: string): void {
    this.users.delete(userId);
  }

  private activeKeys(state: { turn: number; warm: Map<string, WarmEntry> }): string[] {
    const live = new Set<string>();
    for (const [key, entry] of state.warm) {
      if (entry.expiresAtTurn > state.turn) live.add(key);
    }
    // Return in table order for deterministic, priority-stable output.
    return this.topics.map((t) => t.key).filter((k) => live.has(k));
  }
}

// Process-wide singleton so warmth persists across turns within one running
// process (the Map is the whole point). Lazily created. Only ever touched when
// WORLD_STATE_ENABLED is on (see orchestrator.ts), so it costs nothing by default.
let sharedStore: WorldStateStore | null = null;
export function getWorldStateStore(): WorldStateStore {
  if (!sharedStore) sharedStore = new WorldStateStore();
  return sharedStore;
}

// Whether the feature is on. Default-OFF: unset / anything but 'true' = off, so
// the world-state path is never entered and prompts are byte-for-byte unchanged.
export function worldStateEnabled(): boolean {
  return getFlags().worldStateEnabled;
}
