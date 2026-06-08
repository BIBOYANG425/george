// Search USC programs (majors/minors/certificates) ingested from catalogue.usc.edu.
// Uses the same FTS/ILIKE fallback helper as campus_knowledge so it works with or
// without pgvector. Optional `school` filter (matches school name fragment).
// Populated by: scripts/ingest-catalogue.ts (USC catalogue.usc.edu scraper).
//
// Header last reviewed: 2026-06-07

import { z } from 'zod'
import { searchWithFallback } from './search-helpers.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  query: z.string().describe('Free-text search — program name, topic, or school fragment'),
  school: z.string().optional().describe('Optional: restrict to one school, e.g. "Marshall", "Viterbi", "Dornsife"'),
}

export async function searchProgramsHandler(input: {
  query: string
  school?: string
}): Promise<string> {
  const query = String(input.query ?? '').trim()
  const school = input.school ? String(input.school).trim() : undefined
  if (query.length < 2) return 'No programs matched that query.'

  const data = await searchWithFallback<{
    name: string
    degree_type: string | null
    school: string | null
    description: string | null
  }>('programs', 'name, degree_type, school, description', query, {
    ftsColumn: 'description',
    ilikeColumns: ['name', 'description'],
    applyFilters: (q) => (school ? q.ilike('school', `%${school}%`) : q),
  })

  if (!data || data.length === 0) return 'No programs matched that query.'
  return JSON.stringify(data)
}

export const searchProgramsTool = wrapTool({
  name: 'search_programs',
  description: 'Search USC programs (majors, minors, certificates, degrees). Returns name, school, degree_type, and description. Optional school filter.',
  schema: inputSchema,
  handler: searchProgramsHandler,
})
