import { z } from 'zod'
import { createReminder } from '../db/reminders.js'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
  event_id: z.string().describe('The event UUID'),
  remind_at: z.string().describe('When to send reminder (ISO 8601)'),
  platform: z.enum(['wechat', 'imessage']).optional().describe('Platform to send reminder on'),
}

export async function setReminderHandler(input: {
  student_id?: string
  event_id: string
  remind_at: string
  platform?: 'wechat' | 'imessage'
}): Promise<string> {
  if (!input.student_id) return 'No student context available.'
  await supabase.from('event_attendance').upsert({
    student_id: input.student_id,
    event_id: input.event_id,
    source: 'reminder',
  }, { onConflict: 'student_id,event_id' })

  await createReminder(
    input.student_id,
    input.event_id,
    input.remind_at,
    input.platform || 'wechat',
  )
  return `Reminder set! George will poke you at ${input.remind_at}. 👻`
}

export const setReminderTool = wrapTool({
  name: 'set_reminder',
  description: 'Set a reminder for a student about an upcoming event.',
  schema: inputSchema,
  handler: setReminderHandler,
})
