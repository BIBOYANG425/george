// LLM dispatch layer. Wraps Anthropic Claude (main) and Kimi/Moonshot (lightweight fallback)
// behind a unified call signature. Sub-agents use Claude Sonnet 4.6; intent classifier,
// proactive messages, and memory extraction use Kimi/Haiku. Single point to swap models.
//
// Header last reviewed: 2026-04-20

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { log } from '../observability/logger.js'

const claude = new Anthropic({ apiKey: config.anthropic.apiKey })

export function getClaudeClient(): Anthropic {
  return claude
}

export async function callLightweightLLM(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options?: { maxTokens?: number; jsonMode?: boolean; model?: string },
): Promise<string> {
  const apiKey = config.kimi.apiKey

  if (!apiKey) {
    const response = await claude.messages.create({
      // Defaults to the fast Haiku tier (classify/extract/capture). Callers that
      // need more judgment (e.g. the relationship-memory evaluator) may pass a
      // smarter model via options.model — e.g. config.models.smart. Unset keeps
      // every existing caller on Haiku, byte-for-byte.
      model: options?.model || 'claude-haiku-4-5-20251001',
      max_tokens: options?.maxTokens || 500,
      // Lightweight calls (classify, extract, capture) don't need extended
      // thinking; disabling it drops ~7s/call on the DeepSeek-backed fast tier.
      thinking: { type: 'disabled' },
      system: messages.find((m) => m.role === 'system')?.content,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    })
    const text = response.content.find((b) => b.type === 'text')?.text
    return text || ''
  }

  const body: Record<string, unknown> = {
    // model override is only honored for Anthropic ids (the SMART tier is an
    // Anthropic model). On the Kimi path keep the default 8k model unless a
    // caller passes an explicit Kimi/Moonshot model id.
    model: options?.model?.startsWith('moonshot') ? options.model : 'moonshot-v1-8k',
    messages,
    max_tokens: options?.maxTokens || 500,
  }
  if (options?.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const res = await fetch(`${config.kimi.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const err = await res.text()
    log('error', 'kimi_api_error', { status: res.status, body: err })
    throw new Error(`Kimi API error: ${res.status}`)
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  return data.choices[0].message.content
}
