import { z } from 'zod'
import { searchEvents } from '../db/events.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  query: z.string().optional().describe('Search term'),
  category: z.string().optional().describe('Category: social, academic, career, cultural, sports, other'),
  from_date: z.string().optional().describe('Start date (ISO 8601)'),
  to_date: z.string().optional().describe('End date (ISO 8601)'),
}

export async function searchEventsHandler(input: {
  query?: string
  category?: string
  from_date?: string
  to_date?: string
}): Promise<string> {
  const events = await searchEvents({
    query: input.query,
    category: input.category,
    fromDate: input.from_date,
    toDate: input.to_date,
  })
  if (events.length === 0) return 'No events found matching the criteria.'
  return JSON.stringify(events, null, 2)
}

export const searchEventsTool = wrapTool({
  name: 'search_events',
  description: 'Search for upcoming USC and BIA events by keyword, category, or date range.',
  schema: inputSchema,
  handler: searchEventsHandler,
})
