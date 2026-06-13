// src/tools/join-squad-post.ts
// Join a squad post. Inserts into squad_members, marks any pending ping as
// responded, and returns the poster's contact info for introduction.
// The DB enforces capacity via the fn_update_squad_current_people trigger,
// which raises 'squad_full' (plpgsql, SQLSTATE P0001). A 23505 unique_violation
// means the student already joined. Each is mapped to a distinct user payload.

import { z } from 'zod'
import { supabase } from '../db/client.js'
import { resolveStudentId } from '../db/students.js'
import { wrapTool } from './_wrap.js'

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

async function toStudentUuid(raw: string): Promise<string> {
  if (UUID_RX.test(raw)) return raw
  return resolveStudentId(raw, 'imessage')
}

// The capacity trigger fn_update_squad_current_people raises 'squad_full' as a
// plpgsql exception (DEFAULT SQLSTATE P0001 — NOT a 23xxx code). 23505 is a
// unique_violation, meaning the student already joined. We classify precisely so
// each case gets the right user-facing message; post_not_found (also P0001) and
// anything else fall through to a generic error.
type JoinErrorKind = 'squad_full' | 'already_joined' | 'other'

function classifyJoinError(code?: string, message?: string): JoinErrorKind {
  // Capacity: trigger raised 'squad_full' (P0001). Match the message directly so
  // post_not_found (also P0001) doesn't get mislabeled as full.
  if (message && /squad_full/i.test(message)) return 'squad_full'
  // Duplicate join: unique index on (post_id, student_id) → 23505.
  if (code === '23505') return 'already_joined'
  return 'other'
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
      const kind = classifyJoinError(insertErr.code, insertErr.message)
      if (kind === 'squad_full') {
        return JSON.stringify({
          error: 'squad_full',
          message: '这个局满了 🥲 看看别的?',
        })
      }
      if (kind === 'already_joined') {
        return JSON.stringify({
          error: 'already_joined',
          message: '你已经在这个局里了 🫡',
        })
      }
      return JSON.stringify({ error: insertErr.message })
    }

    // 2. Mark any genuinely-sent squad_pings for this (post, student) as responded.
    // Scope to status='sent' so a suppressed ping never gets flipped to 'joined'.
    await supabase
      .from('squad_pings')
      .update({ response: 'joined', responded_at: new Date().toISOString() })
      .eq('post_id', input.post_id)
      .eq('recipient_student_id', studentId)
      .eq('status', 'sent')

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
