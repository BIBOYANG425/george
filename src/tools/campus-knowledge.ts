import { z } from 'zod'
import { searchWithFallback } from './search-helpers.js'
import { wrapTool } from './_wrap.js'

// Embeds text via OpenAI text-embedding-3-small (1536-d, matches schema).
// Returns null if OPENAI_API_KEY is not set — callers should fall back to
// non-vector dedupe/search rather than throwing.
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings error: ${res.status}`)
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> }
  return data.data[0].embedding
}

const inputSchema = {
  query: z.string().describe('What to search for'),
  category: z.string().optional().describe('Category: food, study, buildings, tips, local'),
}

export async function campusKnowledgeHandler(input: {
  query: string
  category?: string
}): Promise<string> {
  const query = input.query
  const category = input.category

  const data = await searchWithFallback<{
    title: string
    content: string
    category: string
  }>('campus_knowledge', 'title, content, category', query, {
    ftsColumn: 'content',
    ilikeColumns: ['title', 'content'],
    applyFilters: (q) => (category ? q.eq('category', category) : q),
  })

  if (!data || data.length === 0) {
    return 'No campus knowledge found for that query.'
  }
  return JSON.stringify(data, null, 2)
}

export const campusKnowledgeTool = wrapTool({
  name: 'campus_knowledge',
  description: "Search George's campus knowledge base for study spots, food recs, building tips.",
  schema: inputSchema,
  handler: campusKnowledgeHandler,
})
