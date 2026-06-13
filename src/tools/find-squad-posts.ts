// src/tools/find-squad-posts.ts
// Find open squad posts for the current student via the hybrid_search_posts_for_user RPC.
// Uses the service-role client (george runs service-role; raw RPC is allowed).
// Returns a capped list — let the model curate to 2-3 in its reply.

import { z } from 'zod'
import { supabase } from '../db/client.js'
import { resolveStudentId } from '../db/students.js'
import { wrapTool } from './_wrap.js'

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

const MAX_RETURNED = 8 // model curates down to 2-3; we give it a small pool

async function toStudentUuid(raw: string): Promise<string> {
  if (UUID_RX.test(raw)) return raw
  return resolveStudentId(raw, 'imessage')
}

const inputSchema = {
  query: z.string().optional().describe('Optional free-text query to hint the RPC'),
  student_id: z.string().optional().describe('The student UUID injected from context'),
}

export async function findSquadPostsHandler(input: {
  query?: string
  student_id?: string
}): Promise<string> {
  try {
    const rawId = input.student_id ?? ''
    const studentId = rawId ? await toStudentUuid(rawId) : ''

    const { data, error } = await supabase.rpc('hybrid_search_posts_for_user', {
      p_student_id: studentId || null,
      p_match_count: 30,
    })

    if (error) {
      return JSON.stringify({ error: error.message })
    }

    const posts = (data as unknown[]).slice(0, MAX_RETURNED)
    return JSON.stringify({ posts })
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message ?? 'unknown error' })
  }
}

export const findSquadPostsTool = wrapTool({
  name: 'find_squad_posts',
  description:
    'Find open squad posts that match this student. ' +
    'Returns a ranked list of posts — pick 2-3 to recommend, never enumerate all. ' +
    'Uses the hybrid (semantic + tag) search RPC.',
  schema: inputSchema,
  handler: findSquadPostsHandler,
})
