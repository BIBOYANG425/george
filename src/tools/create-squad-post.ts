// src/tools/create-squad-post.ts
// The ONLY write path for george-authored squad posts. Resolves identity, embeds
// the content, inserts into squad_posts, then fires the ping fan-out non-fatally.
// Returns aggregate reach ONLY — never recipient ids/handles/names (privacy CEO-D7).
//
// IMPORTANT: only call this AFTER the user has explicitly approved the draft.

import { z } from 'zod'
import { supabase } from '../db/client.js'
import { resolveStudentId, getStudentById } from '../db/students.js'
import { triggerPingFanout } from '../services/squad-ping-deps.js'
import { proposeMatchesForPost } from '../services/match-proposal-deps.js'
import { config } from '../config.js'
import { wrapTool } from './_wrap.js'
import { normalizeSquadCategory } from '../services/squad-categories.js'

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

/** Resolve a raw student_id to a real UUID, calling resolveStudentId when needed. */
async function toStudentUuid(raw: string): Promise<string> {
  if (UUID_RX.test(raw)) return raw
  return resolveStudentId(raw, 'imessage')
}

/**
 * Derive a deduplicated tags array from the post content + category.
 * Simple heuristic: lowercase-split the content into tokens, keep unique,
 * add the category. This is best-effort — the embedding is the real semantic leg.
 */
function deriveTags(content: string, category: string): string[] {
  const tokens = content
    .toLowerCase()
    .split(/[\s,，。！？、\n]+/)
    .filter((t) => t.length >= 2 && t.length <= 10)
  const set = new Set([...tokens, category.toLowerCase()])
  return Array.from(set).slice(0, 20) // cap to 20 tags
}

const inputSchema = {
  student_id: z.string().describe('The student UUID injected from context, or a handle as fallback'),
  content: z.string().describe('Post body — the text the student wants to share'),
  category: z
    .string()
    .describe('Activity category — one of 拼车/自习/健身/游戏/其它. 约会 and unknown values are normalized at runtime.'),
  max_people: z.number().int().min(2).describe('Max headcount including the poster'),
  deadline: z.string().optional().describe('ISO timestamp deadline, optional'),
  location: z.string().optional().describe('Location text, optional'),
  contact: z.string().optional().describe('Contact info, optional'),
}

export async function createSquadPostHandler(input: {
  student_id: string
  content: string
  category: string
  max_people: number
  deadline?: string
  location?: string
  contact?: string
}): Promise<string> {
  try {
    // 1. Resolve UUID
    const createdByStudentId = await toStudentUuid(input.student_id)

    // 1b. Normalize category — rejects romantic asks, coerces unknown → 其它
    const normalizedCategory = normalizeSquadCategory(input.category)
    if (typeof normalizedCategory === 'object' && 'rejected' in normalizedCategory) {
      return JSON.stringify({
        error: 'unsupported_category',
        message: '找搭子只组正经局哈 约会的不发 🫡',
      })
    }
    const category = normalizedCategory

    // 2. Look up the student row for poster_name
    const studentRow = await getStudentById(createdByStudentId).catch(() => null)
    const posterName: string = (studentRow as { name?: string } | null)?.name ?? '学长'

    // 3. Derive tags
    const tags = deriveTags(input.content, category)

    // 4. Best-effort embedding — any error → null, post still created
    let embedding: number[] | null = null
    try {
      const { data: embedData, error: embedErr } = await supabase.functions.invoke('embed', {
        body: { texts: [input.content] },
      })
      if (!embedErr && Array.isArray(embedData?.embeddings?.[0])) {
        embedding = embedData.embeddings[0] as number[]
      }
    } catch {
      // embed unavailable — proceed without it
    }

    // 5. Insert into squad_posts
    const { data: post, error: insertErr } = await supabase
      .from('squad_posts')
      .insert({
        content: input.content,
        category,
        max_people: input.max_people,
        location: input.location ?? null,
        contact: input.contact ?? null,
        deadline: input.deadline ?? null,
        tags,
        embedding,
        created_by_student_id: createdByStudentId,
        created_via: 'george',
        poster_name: posterName,
      })
      .select('id, content, category, max_people')
      .single()

    if (insertErr || !post) {
      return JSON.stringify({ error: insertErr?.message ?? 'insert failed' })
    }

    // 6. Fan out to candidates, non-fatally. Two lanes, flag-selected:
    //    - CONCIERGE_MATCH_ENABLED=true → queue matches for the officer glance (proposed_matches);
    //      reach = number of proposals queued for review (NOT yet delivered).
    //    - default (OFF)                → today's auto ping fan-out; reach = pings sent.
    //    Both are awaited blocking calls; a failure never blocks post creation (post already exists),
    //    and reach stays an aggregate count — never a recipient identity.
    let reach: number | null = null
    try {
      reach = config.concierge.matchEnabled
        ? await proposeMatchesForPost(post.id)
        : (await triggerPingFanout(post.id)).sent
    } catch {
      // fan-out delayed — post still created
    }

    // 7. Return aggregate only — NO recipient identity fields
    return JSON.stringify({
      ok: true,
      post_id: post.id,
      reach,
    })
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message ?? 'unknown error' })
  }
}

export const createSquadPostTool = wrapTool({
  name: 'create_squad_post',
  description:
    'Create a squad post so others can find and join the activity. ' +
    'Call this ONLY after the user has explicitly approved the draft you showed them. ' +
    'Returns { ok, post_id, reach } — never exposes recipient identities.',
  schema: inputSchema,
  handler: createSquadPostHandler,
})
