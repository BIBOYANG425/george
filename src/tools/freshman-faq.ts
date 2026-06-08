import { z } from 'zod'
import { searchWithFallback } from './search-helpers.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  query: z.string().describe('What to search for'),
  category: z.string().optional().describe('Optional: housing | academics | social | admin | food | general'),
}

export async function freshmanFaqHandler(input: {
  query: string
  category?: string
}): Promise<string> {
  const query = input.query
  const category = input.category

  const data = await searchWithFallback<{
    question: string
    answer: string
    category: string
  }>('freshman_faq', 'question, answer, category', query, {
    ftsColumn: 'answer',
    ilikeColumns: ['question', 'answer'],
    applyFilters: (q) => (category ? q.eq('category', category) : q),
  })

  if (!data || data.length === 0) {
    return 'No FAQ entries found for that query.'
  }
  return JSON.stringify(data, null, 2)
}

export const freshmanFaqTool = wrapTool({
  name: 'freshman_faq',
  description: "Search senior-answered freshman FAQ distilled from the BIA 2024 WeChat group. Covers housing, academics, social, admin, food, and general USC life.",
  schema: inputSchema,
  handler: freshmanFaqHandler,
})
