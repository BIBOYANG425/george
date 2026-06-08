import { z } from 'zod'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
  title: z.string().describe('Event title'),
  description: z.string().optional().describe('Event description'),
  date: z.string().optional().describe('Event date (ISO 8601)'),
  location: z.string().optional().describe('Event location'),
}

export async function submitEventHandler(input: {
  student_id?: string
  title: string
  description?: string
  date?: string
  location?: string
}): Promise<string> {
  if (!input.student_id) return 'No student context available.'
  const { error } = await supabase.from('event_submissions').insert({
    student_id: input.student_id,
    title: input.title,
    description: input.description || null,
    date: input.date || null,
    location: input.location || null,
  })
  if (error) return 'Failed to submit event.'
  return 'Event submitted! BIA team will review it soon. 🐕'
}

export const submitEventTool = wrapTool({
  name: 'submit_event',
  description: 'Submit a community event for BIA team review.',
  schema: inputSchema,
  handler: submitEventHandler,
})
