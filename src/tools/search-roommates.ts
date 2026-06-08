import { z } from 'zod'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  query: z.string().optional().describe('Search term'),
  gender: z.string().optional().describe('Gender filter'),
  year: z.string().optional().describe('Year filter'),
}

export async function searchRoommatesHandler(input: {
  query?: string
  gender?: string
  year?: string
}): Promise<string> {
  let q = supabase
    .from('roommate_profiles')
    .select('name, gender, year, major, sleep_habit, clean_level, noise_level, hobbies, bio')
    .order('created_at', { ascending: false })
    .limit(10)
  if (input.gender) q = q.eq('gender', input.gender)
  if (input.year) q = q.eq('year', input.year)
  if (input.query) {
    const query = input.query.replace(/[%_.*(),]/g, '')
    if (query.length > 0) {
      q = q.or(`name.ilike.%${query}%,major.ilike.%${query}%,hobbies.ilike.%${query}%`)
    }
  }
  const { data } = await q
  if (!data || data.length === 0) return 'No roommate profiles found.'
  return JSON.stringify(data, null, 2)
}

export const searchRoommatesTool = wrapTool({
  name: 'search_roommates',
  description: 'Search BIA roommate profiles.',
  schema: inputSchema,
  handler: searchRoommatesHandler,
})
