import { z } from 'zod'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  max_price: z.number().optional().describe('Maximum monthly rent'),
  location: z.string().optional().describe('Location preference'),
  available_from: z.string().optional().describe('Earliest move-in date'),
}

export async function searchSubletsHandler(input: {
  max_price?: number
  location?: string
  available_from?: string
}): Promise<string> {
  let q = supabase
    .from('sublets')
    .select('title, description, location, price_monthly, available_from, available_to')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(10)
  if (typeof input.max_price === 'number') q = q.lte('price_monthly', input.max_price)
  if (input.location) q = q.ilike('location', `%${input.location}%`)
  if (input.available_from) q = q.gte('available_from', input.available_from)
  const { data, error } = await q
  if (error) return 'Failed to search sublets.'
  if (!data || data.length === 0) return 'No sublets found.'
  return JSON.stringify(data, null, 2)
}

export const searchSubletsTool = wrapTool({
  name: 'search_sublets',
  description: 'Search available sublets and housing near USC.',
  schema: inputSchema,
  handler: searchSubletsHandler,
})
