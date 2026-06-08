import { z } from 'zod'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  student_id: z.string().optional().describe('Current student UUID'),
  interest: z.string().optional().describe('Interest to match on'),
  event_id: z.string().optional().describe('Find others attending this event'),
}

export async function suggestConnectionHandler(input: {
  student_id?: string
  interest?: string
  event_id?: string
}): Promise<string> {
  const studentId = input.student_id as string
  const { data: connections } = await supabase
    .from('student_connections')
    .select('student_b_id, source, strength')
    .eq('student_a_id', studentId)
    .order('strength', { ascending: false })
    .limit(5)

  if (input.event_id) {
    const { data: attendees } = await supabase
      .from('event_attendance')
      .select('student_id')
      .eq('event_id', input.event_id as string)
      .neq('student_id', studentId)
      .limit(10)
    if (!attendees || attendees.length === 0) return 'No other students have signed up for this event yet.'
    const friendIds = new Set((connections || []).map((c) => c.student_b_id))
    const friendCount = attendees.filter((a) => friendIds.has(a.student_id)).length
    return JSON.stringify({ attendees: attendees.length, friends_attending: friendCount }, null, 2)
  }

  if (input.interest) {
    const { data } = await supabase
      .from('students')
      .select('id, name, major, interests')
      .contains('interests', [input.interest as string])
      .neq('id', studentId)
      .neq('social_visibility', false)
      .limit(5)
    if (!data || data.length === 0) return 'No students found with matching interests.'
    const safe = data.map(({ id: _id, ...rest }) => rest)
    return JSON.stringify(safe, null, 2)
  }

  return 'Provide an interest or event_id to find connections.'
}

export const suggestConnectionTool = wrapTool({
  name: 'suggest_connection',
  description: 'Find students with similar interests or attending the same events.',
  schema: inputSchema,
  handler: suggestConnectionHandler,
})
