// src/tools/embed-text.ts
//
// OpenAI embedding helper, extracted from campus-knowledge.ts so DASHBOARD-side
// code (src/admin/knowledge-admin.ts, running in the standalone dashboard service)
// can embed-on-write without importing campus-knowledge.ts → _wrap.ts →
// @anthropic-ai/claude-agent-sdk. This module is a leaf: fetch + env only.
// campus-knowledge.ts re-exports it, so existing importers are unchanged.

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
