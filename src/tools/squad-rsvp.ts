// src/tools/squad-rsvp.ts
// Inbound coordination replies (Phase 4). The Coordinator sends; this tool
// records what the member replies over iMessage:
//   confirm -> squad_members.rsvp_status='confirmed'
//   drop    -> delete my member row (capacity trigger decrements) + post.needs_refill=true
//   join    -> delegate to join_squad_post (reply to a web-interest broker nudge)
// {error}-never-throw, mirroring join-squad-post.ts.
import { z } from 'zod'
import { supabase } from '../db/client.js'
import { resolveStudentId } from '../db/students.js'
import { wrapTool } from './_wrap.js'
import { joinSquadPostHandler } from './join-squad-post.js'

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
async function toStudentUuid(raw: string): Promise<string> {
  if (UUID_RX.test(raw)) return raw
  return resolveStudentId(raw, 'imessage')
}

const inputSchema = {
  decision: z.enum(['confirm', 'drop', 'join']).describe('confirm = 来/还在, drop = 不来/退出, join = 想加入 (reply to a broker nudge)'),
  post_id: z.string().describe('UUID of the 局 the reply is about'),
  student_id: z.string().optional().describe('The student UUID injected from context'),
}

export async function squadRsvpHandler(input: {
  decision: 'confirm' | 'drop' | 'join'
  post_id?: string
  student_id?: string
}): Promise<string> {
  try {
    if (!input.post_id) return JSON.stringify({ error: 'post_id required' })
    const rawId = input.student_id ?? ''
    const studentId = rawId ? await toStudentUuid(rawId) : ''
    if (!studentId) return JSON.stringify({ error: 'student_id required' })

    if (input.decision === 'join') {
      return await joinSquadPostHandler({ post_id: input.post_id, student_id: studentId })
    }

    if (input.decision === 'confirm') {
      const { error } = await supabase
        .from('squad_members')
        .update({ rsvp_status: 'confirmed', rsvp_at: new Date().toISOString() })
        .eq('post_id', input.post_id)
        .eq('student_id', studentId)
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ ok: true, rsvp: 'confirmed' })
    }

    // drop: free the spot (capacity trigger decrements current_people) and flag refill.
    const { error: delErr } = await supabase
      .from('squad_members')
      .delete()
      .eq('post_id', input.post_id)
      .eq('student_id', studentId)
    if (delErr) return JSON.stringify({ error: delErr.message })
    await supabase.from('squad_posts').update({ needs_refill: true }).eq('id', input.post_id)
    return JSON.stringify({ ok: true, rsvp: 'dropped' })
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message ?? 'unknown error' })
  }
}

export const squadRsvpTool = wrapTool({
  name: 'squad_rsvp',
  description:
    'Record a member reply to a 局 coordination message: confirm (来/还在), drop (不来/退出 — frees the spot), or join (想加入 — completes a web-expressed interest). ' +
    'Input: { decision, post_id, student_id }. Use ONLY when the user clearly answers about a specific 局; if which 局 is ambiguous, ask first — never guess a post.',
  schema: inputSchema,
  handler: squadRsvpHandler,
})
