import { z } from 'zod'
import { searchWithFallback } from './search-helpers.js'
import { wrapTool } from './_wrap.js'
import { HOUSE_RULE_CATEGORY } from './house-rules.js'
import { getFlags } from '../flags.js'

// embedText moved to its own SDK-free leaf module (embed-text.ts) so the
// dashboard write path (knowledge-admin.ts) can import it without dragging in
// the agent SDK via _wrap.ts. Re-exported here so existing importers
// (scripts/ingest-wechat.ts etc.) are unchanged.
export { embedText } from './embed-text.js'

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
    // Teach george (GEORGE_TEACH_ENABLED): admin house-rule rows live in this
    // table under a reserved category and must never surface as facts. The
    // exclusion is itself flag-gated so a fully-OFF deployment issues the exact
    // pre-feature query (byte-identical).
    applyFilters: (q) => {
      let out = category ? q.eq('category', category) : q
      if (getFlags().teachEnabled) out = out.neq('category', HOUSE_RULE_CATEGORY)
      return out
    },
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
