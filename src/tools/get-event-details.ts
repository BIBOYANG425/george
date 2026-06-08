import { z } from 'zod'
import { getEventById } from '../db/events.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  event_id: z.string().describe('The UUID of the event'),
}

export async function getEventDetailsHandler(input: { event_id: string }): Promise<string> {
  const event = await getEventById(input.event_id)
  if (!event) return 'Event not found.'
  return JSON.stringify(event, null, 2)
}

export const getEventDetailsTool = wrapTool({
  name: 'get_event_details',
  description: 'Get full details for a specific event by ID.',
  schema: inputSchema,
  handler: getEventDetailsHandler,
})
