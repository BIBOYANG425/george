// src/tools/recall-memory.ts
// P6 Phase 5 (post-MVP): the DELIBERATE recall TOOL. Complements the always-on
// per-turn auto-injected recall (recallForTurn → "## THINGS YOU REMEMBER"): when
// George wants to actively look something up about THIS student ("what did they
// say about their visa last month?"), he calls this with a specific query instead
// of relying only on what the auto-inject surfaced for the raw user message.
//
// Gated by GEORGE_RECALL_TOOL_ENABLED (default-OFF). The orchestrator only adds it
// to the assembled tool set when the flag is on, so OFF = tool absent = byte-
// identical agent behavior. It does NOT run on the fast path (tools don't run
// there) — that's expected; auto-inject covers the fast path.
//
// Identity: like recallForTurn, observations are keyed by students.user_id (the
// uuid that user_profiles is keyed by), resolved from the channel handle via
// resolveProfileUserId. The handle is injected into context by the orchestrator's
// gated recall-context block (only present when the flag is on); the model passes
// it as user_id. A non-onboarded handle (resolve → null) → graceful empty result.
//
// Anti-fabrication: returns ONLY real stored observations. On any error / no
// results / non-onboarded → a graceful "no relevant memories" result. NEVER throws
// (wrapTool also backstops), so a recall failure can never break a turn.

import { z } from 'zod'
import { getFlags } from '../flags.js'
import { resolveProfileUserId } from '../db/students.js'
import { log } from '../observability/logger.js'
import {
  embedObservation,
  createSupabaseObservationDB,
  type ObservationDB,
  type RecalledObservation,
} from '../memory/observations.js'
import { resolveTopK, resolveMinSalience, resolveHalfLifeDays } from '../memory/recall.js'
import { wrapTool } from './_wrap.js'

export function isRecallToolEnabled(): boolean {
  return getFlags().recallToolEnabled
}

const EMPTY_RESULT = JSON.stringify({ memories: [], note: 'no relevant memories found' })

const inputSchema = {
  query: z
    .string()
    .describe(
      'What to recall about THIS student, in your own words — the topic/question to ' +
        'search their memory for (e.g. "their visa situation", "how the CSCI 270 final went").',
    ),
  user_id: z
    .string()
    .optional()
    .describe('The current student id/handle injected from context. Pass it exactly as given.'),
}

// Deps are injectable so tests run with a fake store + fake embed + mocked resolve
// (mirrors recallForTurn's deps seam). Production uses the real Supabase machinery.
export interface RecallMemoryDeps {
  db?: ObservationDB
  embed?: (t: string) => Promise<number[] | null>
  resolve?: (handle: string) => Promise<string | null>
}

export async function recallMemoryHandler(
  input: { query?: string; user_id?: string },
  deps?: RecallMemoryDeps,
): Promise<string> {
  try {
    const query = (input.query ?? '').trim()
    if (!query) return EMPTY_RESULT

    const handle = (input.user_id ?? '').trim()
    if (!handle) return EMPTY_RESULT

    // Resolve the channel handle → the user_observations uuid key. Non-onboarded
    // handles have no uuid-keyed memory → graceful empty.
    const resolve = deps?.resolve ?? resolveProfileUserId
    const userId = await resolve(handle)
    if (!userId) return EMPTY_RESULT

    // Best-effort embed; null (couldn't embed) → graceful empty rather than throw.
    const embed = deps?.embed ?? embedObservation
    const embedding = await embed(query)
    if (!embedding) return EMPTY_RESULT

    const db = deps?.db ?? createSupabaseObservationDB()
    const rows: RecalledObservation[] = await db.recall(
      userId,
      embedding,
      resolveTopK(),
      resolveMinSalience(),
      resolveHalfLifeDays(),
    )
    if (rows.length === 0) return EMPTY_RESULT

    log('info', 'recall_tool_hit', { count: rows.length, topScore: rows[0]?.score })

    // Concise, structured result the model can weave in — real stored content only.
    return JSON.stringify({
      memories: rows.map((r) => ({ content: r.content, salience: r.salience, kind: r.kind })),
    })
  } catch (e) {
    log('warn', 'recall_tool_failed', { error: (e as Error).message })
    return EMPTY_RESULT
  }
}

export const recallMemoryTool = wrapTool({
  name: 'recall_memory',
  description:
    "Search your own memory of THIS student for a specific detail you want to recall " +
    "deliberately (something they told you before that the auto-surfaced memories did not " +
    "bring up). Returns ONLY real stored observations — never invent a memory. Empty result " +
    'means you genuinely have nothing on it; say so in voice rather than guessing.',
  schema: inputSchema,
  handler: recallMemoryHandler,
})
