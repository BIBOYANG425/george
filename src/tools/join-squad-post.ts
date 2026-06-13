// src/tools/join-squad-post.ts
// Join a squad post. Inserts into squad_members, marks any pending ping as
// responded, and returns the poster's contact info for introduction.
// The DB enforces capacity via a trigger; a 23xxx error code or a trigger
// message containing "full" is returned as the squad_full error payload.

import { z } from 'zod'
import { supabase } from '../db/client.js'
import { resolveStudentId } from '../db/students.js'
import { wrapTool } from './_wrap.js'

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

async function toStudentUuid(raw: string): Promise<string> {
  if (UUID_RX.test(raw)) return raw
  return resolveStudentId(raw, 'imessage')
}

/** True when the Postgres error indicates a capacity / constraint violation. */
function isCapacityError(code?: string, message?: string): boolean {
  if (!code && !message) return false
  // 23xxx family: integrity constraint violations
  if (code && /^23/.test(code)) return true
  // Trigger-raised application errors mentioning "full"
  if (message && /full/i.test(message)) return true
  return false
}

const inputSchema = {
  post_id: z.string().describe('UUID of the squad post to join'),
  student_id: z.string().optional().describe('The student UUID injected from context'),
}

export async function joinSquadPostHandler(input: {
  post_id: string
  student_id?: string
}): Promise<string> {
  try {
    const rawId = input.student_id ?? ''
    const studentId = rawId ? await toStudentUuid(rawId) : ''

    if (!studentId) {
      return JSON.stringify({ error: 'student_id required' })
    }

    // 1. Insert into squad_members
    const { error: insertErr } = await supabase.from('squad_members').insert({
      post_id: input.post_id,
      student_id: studentId,
    })

    if (insertErr) {
      if (isCapacityError(insertErr.code, insertErr.message)) {
        return JSON.stringify({
          error: 'squad_full',
          message: '这个局满了 🥲 看看别的?',
        })
      }
      return JSON.stringify({ error: insertErr.message })
    }

    // 2. Mark any pending squad_pings for this (post, student) as responded
    await supabase
      .from('squad_pings')
      .update({ response: 'joined', responded_at: new Date().toISOString() })
      .eq('post_id', input.post_id)
      .eq('recipient_student_id', studentId)

    // 3. Fetch poster contact info for intro
    const { data: postData } = await supabase
      .from('squad_posts')
      .select('poster_name, contact')
      .eq('id', input.post_id)
      .single()

    return JSON.stringify({
      ok: true,
      poster_name: (postData as { poster_name?: string } | null)?.poster_name ?? null,
      contact: (postData as { contact?: string } | null)?.contact ?? null,
    })
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message ?? 'unknown error' })
  }
}

export const joinSquadPostTool = wrapTool({
  name: 'join_squad_post',
  description:
    'Join a squad post on behalf of the student. ' +
    'Handles capacity enforcement (squad_full) and marks pings responded. ' +
    'Returns poster contact info for the intro message.',
  schema: inputSchema,
  handler: joinSquadPostHandler,
})
