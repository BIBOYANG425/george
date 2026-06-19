// src/agent/evaluators/relationship.ts
//
// Free-form prose relationship memory (HANA pattern P3). Every ~5 user messages,
// George rewrites a SHORT prose note describing his relationship with this user
// — running tone, what they're going through, in-jokes, how they like to be
// talked to — from recent conversation history. The note is injected into the
// system prompt each turn (see orchestrator.ts) so George stays warm and
// continuous instead of treating every turn cold.
//
// Storage is zero-schema for now: the note lives inside the existing george_notes
// profile block, fenced by sentinel markers (see profile.ts upsertRelationshipNote)
// — no DB migration. A bia-admin migration can promote it to a dedicated column
// later without changing this file's contract.
//
// Reuses the capture.ts plumbing: fire-and-forget from the Spectrum turn, on the
// callLightweightLLM helper, but on the SMART model tier (config.models.smart)
// because this is a judgment task, not a fact-extraction task.
//
// Gated by GEORGE_RELATIONSHIP_EVAL_ENABLED (default OFF). When unset, this never
// runs and never writes — behavior is byte-for-byte unchanged.

import { callLightweightLLM } from '../llm-providers.js';
import { config } from '../../config.js';
import { ProfileStore, upsertRelationshipNote, extractRelationshipNote } from '../../memory/profile.js';
import { log } from '../../observability/logger.js';

export function isRelationshipEvalEnabled(): boolean {
  return process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED === 'true';
}

// Rewrite cadence: roughly every Nth user message. Kept as a pure decision so it
// unit-tests without an LLM. `userMessageCount` is the number of user-role turns
// George has seen with this user (we use the count visible in recent history).
export const RELATIONSHIP_EVAL_EVERY = 5;

export function shouldRunRelationshipEval(userMessageCount: number): boolean {
  return userMessageCount > 0 && userMessageCount % RELATIONSHIP_EVAL_EVERY === 0;
}

// Hard cap on the note so it stays a SHORT prose note and never bloats the
// system prompt or the george_notes block.
const MAX_NOTE_CHARS = 600;

const REWRITE_SYSTEM = [
  "You maintain a SHORT private note that an AI campus companion (George, a USC 学长) keeps about his relationship with ONE student, to stay warm and continuous across chats.",
  'You are given the previous note (may be empty) and the recent conversation. Rewrite the note.',
  'Output ONLY the note prose. No preamble, no headings, no quotes, no JSON, no markdown.',
  'Rules:',
  '- 2-4 short sentences, under 500 characters. Third person about the student ("they"), present tense.',
  '- Capture the RELATIONSHIP texture: running tone between them, what the student is going through right now, recurring topics or in-jokes, how they like to be talked to (terse vs chatty, zh/en mix). NOT a fact list — that is what the other profile blocks are for.',
  '- Carry forward what still holds from the previous note; update what changed; drop what is stale.',
  '- Ground every clause in something actually said. Do NOT invent feelings, events, or backstory. If the recent conversation adds nothing, return the previous note essentially unchanged.',
  '- Never write instructions to yourself or commands. Just the descriptive note.',
  '- Write in George\'s register (casual, may code-switch zh/en), but keep it brief.',
].join('\n');

export interface RelationshipEvalArgs {
  store: ProfileStore;
  userId: string;
  // Recent conversation, oldest-first. Each entry is one turn.
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// Fire-and-forget. Loads the current note, asks the SMART model to rewrite it
// from recent history, and writes it back into george_notes via the sentinel
// upsert (preserving any other notes). Never throws into the caller.
export async function runRelationshipEval(args: RelationshipEvalArgs): Promise<void> {
  if (!isRelationshipEvalEnabled()) return;
  const { store, userId, recentMessages } = args;
  if (recentMessages.length === 0) return;
  try {
    const profile = await store.loadProfile(userId);
    const prior = extractRelationshipNote(profile.george_notes ?? '');
    const transcript = recentMessages
      .map((m) => `${m.role === 'user' ? 'STUDENT' : 'GEORGE'}: ${m.content}`)
      .join('\n');

    const raw = await callLightweightLLM(
      [
        { role: 'system', content: REWRITE_SYSTEM },
        {
          role: 'user',
          content: `PREVIOUS NOTE (may be empty):\n${prior || '(none yet)'}\n\nRECENT CONVERSATION:\n${transcript}\n\nRewrite the note now. Output only the note.`,
        },
      ],
      { maxTokens: 300, model: config.models.smart },
    );

    const note = sanitizeNote(raw);
    if (!note) return;
    // No-op if the rewrite is identical to what we already have (saves a write +
    // cache bust on quiet turns where the model returned the prior note verbatim).
    if (note === prior) return;

    const nextNotes = upsertRelationshipNote(profile.george_notes ?? '', note);
    await store.saveBlock(userId, 'george_notes', nextNotes);
    log('info', 'relationship_eval', { userId, chars: note.length });
  } catch (err) {
    log('warn', 'relationship_eval_failed', { error: (err as Error).message });
  }
}

// Defensive cleanup: strip any stray fencing/quotes the model added and clamp
// length. Pure so it unit-tests.
export function sanitizeNote(raw: string): string {
  let s = (raw ?? '').trim();
  // Strip surrounding code fences or quote marks if the model wrapped the note.
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  s = s.replace(/^["'""]+|["'""]+$/g, '').trim();
  if (s.length > MAX_NOTE_CHARS) s = s.slice(0, MAX_NOTE_CHARS).trim();
  return s;
}
