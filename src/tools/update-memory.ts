// src/tools/update-memory.ts
// The DELIBERATE memory-WRITE tool — the precision counterpart to the always-on,
// blind per-turn capturer (src/memory/capture.ts). When George is mid-reply and
// the student reveals a durable fact about themselves ("I switched my major to
// CS", "I moved to the Lorenzo"), he calls this to record ONE high-signal fact to
// the right profile block, instead of relying only on the capturer's broad sweep.
//
// Gated by GEORGE_UPDATE_MEMORY_TOOL_ENABLED (default-OFF). The orchestrator only
// adds it to the assembled tool set when the flag is on, so OFF = tool absent =
// byte-identical agent behavior. It does NOT run on the fast path (tools don't run
// there) — that's expected; the per-turn capturer covers the fast path.
//
// Identity: like the capturer and recall_memory, profiles are keyed by
// students.user_id (the uuid user_profiles is keyed by), resolved from the channel
// handle via resolveProfileUserId. The handle is injected into context by the
// orchestrator's gated memory-tools context block (present when this OR the recall
// flag is on); the model passes it as user_id. A non-onboarded handle (resolve →
// null) → graceful no-op.
//
// Two safety gates share the capturer's machinery so the two writers can't drift:
//   - block ∈ DURABLE_FACT_BLOCKS (the shared allowlist; george_notes excluded)
//   - consent_memory must be granted (getMemoryConsent, FAIL-CLOSED) before any
//     PII lands in user_profiles
// On any miss / error → a graceful "not saved" result. NEVER throws (wrapTool also
// backstops), so a memory-write failure can never break a turn. Writes go through
// ProfileStore.appendToBlock → the atomic append_to_profile_block RPC (substring
// dedup + cache bust), so capturer + tool writing the same fact never double-stores.

import { z } from 'zod'
import { getFlags } from '../flags.js'
import { resolveProfileUserId, getMemoryConsent } from '../db/students.js'
import { log } from '../observability/logger.js'
import {
  ProfileStore,
  createSupabaseProfileDB,
  DURABLE_FACT_BLOCKS,
  type BlockName,
} from '../memory/profile.js'
import { getKVCache } from '../memory/kv-cache.js'
import { wrapTool } from './_wrap.js'

export function isUpdateMemoryToolEnabled(): boolean {
  return getFlags().updateMemoryToolEnabled
}

// Graceful, non-throwing outcomes the model can read back. A "not saved" result is
// never an error the turn should surface — George just keeps talking.
const notSaved = (note: string): string => JSON.stringify({ saved: false, note })

const inputSchema = {
  block: z
    .string()
    .describe(
      'Which part of the student\'s profile this fact belongs to. One of: ' +
        '"identity" (who they are — name, hometown, background), ' +
        '"academic" (major, year, courses, plans), ' +
        '"interests" (hobbies, tastes, what they\'re into), ' +
        '"relationships" (people in their life, friends, family), ' +
        '"state" (current ongoing situation — housing, mood, what they\'re dealing with now).',
    ),
  fact: z
    .string()
    .describe(
      'ONE short third-person fact the student actually stated about themselves, e.g. ' +
        '"switched major to CS, junior" or "moved to the Lorenzo". Only what they really ' +
        'said — never infer or invent. Skip chit-chat and one-off details.',
    ),
  user_id: z
    .string()
    .optional()
    .describe('The current student id/handle injected from context. Pass it exactly as given.'),
}

// Deps injectable so tests run with a fake store + mocked resolve/consent (mirrors
// recall_memory's deps seam). Production lazily builds the real Supabase store.
export interface UpdateMemoryDeps {
  store?: ProfileStore
  resolve?: (handle: string) => Promise<string | null>
  consent?: (id: string) => Promise<boolean>
}

export async function updateMemoryHandler(
  input: { block?: string; fact?: string; user_id?: string },
  deps?: UpdateMemoryDeps,
): Promise<string> {
  try {
    const fact = (input.fact ?? '').trim()
    if (!fact) return notSaved('empty fact — nothing to record')

    const block = (input.block ?? '').trim() as BlockName
    // Shared allowlist with the capturer; george_notes (George's scratchpad) is
    // deliberately not writable here.
    if (!DURABLE_FACT_BLOCKS.includes(block)) {
      return notSaved(`invalid block "${input.block ?? ''}" — must be one of ${DURABLE_FACT_BLOCKS.join(', ')}`)
    }

    const handle = (input.user_id ?? '').trim()
    if (!handle) return notSaved('no student id in context')

    // Resolve handle → the user_profiles uuid key. Non-onboarded handle → no uuid
    // → nothing to write to → graceful no-op (never an invalid-uuid throw).
    const resolve = deps?.resolve ?? resolveProfileUserId
    const userId = await resolve(handle)
    if (!userId) return notSaved('not an onboarded student — no profile to update')

    // PII consent gate, FAIL-CLOSED (mirrors the capturer). No consent → no write.
    const consent = deps?.consent ?? getMemoryConsent
    if (!(await consent(userId))) return notSaved('memory not enabled for this student')

    const store = deps?.store ?? new ProfileStore(createSupabaseProfileDB(), getKVCache())
    await store.appendToBlock(userId, block, fact)
    log('info', 'update_memory_tool_write', { block })
    return JSON.stringify({ saved: true, block, fact })
  } catch (e) {
    log('warn', 'update_memory_tool_failed', { error: (e as Error).message })
    return notSaved('could not save right now')
  }
}

export const updateMemoryTool = wrapTool({
  name: 'update_memory',
  description:
    "Save ONE durable fact the student just told you about themselves (their major, year, " +
    'housing, interests, relationships, ongoing situation) to your long-term memory of them, ' +
    'so you remember it next time. Record ONLY what they actually said — never infer or invent, ' +
    "and skip chit-chat or one-off details. A \"saved\":false result is fine (memory off, or " +
    "nothing onboarded) — just keep talking, don't mention it.",
  schema: inputSchema,
  handler: updateMemoryHandler,
})
