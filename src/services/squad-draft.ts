import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { normalizeSquadCategory, type SquadCategory } from './squad-categories.js'

// Cache the Anthropic client at module scope so we don't construct a new one on
// every draft request. Lazy init so a missing key surfaces at first use rather
// than at module import.
let _anthropic: Anthropic | null = null
function anthropicClient(): Anthropic {
  if (!_anthropic) {
    if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY not set')
    _anthropic = new Anthropic({ apiKey: config.anthropic.apiKey })
  }
  return _anthropic
}

export type DraftResult =
  | {
      ok: true
      draft: {
        category: SquadCategory
        content: string
        location: string | null
        max_people: number
        deadline: string | null
        tags: string[]
      }
    }
  | { error: 'unsupported_category' }
  | { error: 'draft_unavailable' }

const SYSTEM_PROMPT = `You are a USC student group-activity post extractor. Extract a 找搭子 (group activity) post from the user's free-text description.

Output ONLY valid JSON with no extra text, no markdown, no code fences. The JSON must match this exact shape:
{"category":"<one of: 拼车/自习/健身/游戏/其它>","content":"<post body text in Chinese>","location":"<location string or null>","max_people":<integer 2 or more>,"deadline":"<ISO timestamp string or null>","tags":["<tag1>","<tag2>"]}

Rules:
- category MUST be exactly one of: 拼车, 自习, 健身, 游戏, 其它
- If the request is a date, romantic, or relationship-seeking ask, output {"category":"约会"} and nothing else
- content should be a natural Chinese post body describing the activity
- max_people must be an integer >= 2; default to 4 if not specified
- location should be a specific place or null if not mentioned
- deadline should be an ISO 8601 timestamp string or null if not mentioned
- tags should be 2-5 short Chinese or English tags relevant to the activity`

export async function draftSquadPost(
  text: string,
  deps?: { complete?: (prompt: string) => Promise<string> },
): Promise<DraftResult> {
  const complete =
    deps?.complete ??
    (async (prompt: string): Promise<string> => {
      const client = anthropicClient()
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = response.content.find((b) => b.type === 'text')
      return (block as { type: 'text'; text: string } | undefined)?.text ?? ''
    })

  let raw: string
  try {
    raw = await complete(text)
  } catch {
    return { error: 'draft_unavailable' }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.trim()) as Record<string, unknown>
  } catch {
    return { error: 'draft_unavailable' }
  }

  // Run category through normalizer first
  const rawCategory = typeof parsed.category === 'string' ? parsed.category : ''
  const normalized = normalizeSquadCategory(rawCategory)

  if (typeof normalized === 'object' && 'rejected' in normalized) {
    return { error: 'unsupported_category' }
  }

  // Validate required fields
  const content = typeof parsed.content === 'string' ? parsed.content : null
  const maxPeople =
    typeof parsed.max_people === 'number' && Number.isInteger(parsed.max_people) && parsed.max_people >= 2
      ? parsed.max_people
      : null

  if (!content || maxPeople === null) {
    return { error: 'draft_unavailable' }
  }

  const location = typeof parsed.location === 'string' ? parsed.location : null
  const deadline = typeof parsed.deadline === 'string' ? parsed.deadline : null
  const tags = Array.isArray(parsed.tags)
    ? (parsed.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : []

  return {
    ok: true,
    draft: {
      category: normalized,
      content,
      location,
      max_people: maxPeople,
      deadline,
      tags,
    },
  }
}
