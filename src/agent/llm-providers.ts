// LLM dispatch layer. Wraps Anthropic Claude (main) and Kimi/Moonshot (lightweight)
// behind a unified call signature. Sub-agents use Claude Sonnet 4.6. Lightweight
// calls (intent classify, capture, proactive, relationship note) go to Kimi when a
// key is set, else the configured fast tier (config.models.fast). A caller passing
// an Anthropic model id (e.g. the SMART tier) is ALWAYS routed to Claude, even with
// a Kimi key. Single point to swap models.
//
// Header last reviewed: 2026-06-19

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

  // A non-Moonshot model id is an Anthropic model (e.g. config.models.smart =
  // claude-sonnet-4-6). Those MUST run on Claude even when a Kimi key is
  // configured — otherwise the SMART tier the relationship evaluator asks for is
  // silently downgraded to Kimi's moonshot-v1-8k. So route to Claude whenever
  // there's no Kimi key OR the caller explicitly requested an Anthropic model.
  const wantsAnthropicModel = !!options?.model && !options.model.startsWith('moonshot')

  if (!apiKey || wantsAnthropicModel) {
    const response = await claude.messages.create({
      // Defaults to the configured FAST tier (config.models.fast) for the
      // lightweight tasks that reach this Claude path (classify/extract/capture).
      // Callers needing more judgment (e.g. the relationship-memory evaluator)
      // pass a smarter Anthropic model via options.model — e.g. config.models.smart
      // — and it is honored here regardless of the Kimi key.
      model: wantsAnthropicModel ? (options!.model as string) : config.models.fast,
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
    // We only reach the Kimi path with no model override or an explicit
    // Moonshot id (Anthropic ids were routed to Claude above). Keep the default
    // 8k model unless the caller named a specific Moonshot model.
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
