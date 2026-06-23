// src/agent/openai-fast-client.ts
//
// Generic OpenAI-format chat-completion client for the FAST PATH (no-tool emotional
// replies). One POST to `${baseUrl}/chat/completions`, Bearer auth, returns
// choices[0].message.content. This is the shared primitive behind every emotional-tier
// provider that speaks the OpenAI wire format:
//
//   doubaoChat (Ark)         → openaiChat({ Ark base, DOUBAO_API_KEY, model }, …, {reasoning_effort})
//   openaiFastReply (OpenAI) → openaiChat({ OpenAI base, OPENAI_API_KEY, gpt-id }, …)
//
// Anthropic/Claude/DeepSeek emotional ids do NOT come here — they go through
// callLightweightLLM (Anthropic SDK / gateway). Throws on any non-2xx so the caller
// can fall back to the lightweight tier (a provider outage never pushes casual chat
// to the slow full agent).

import { log } from '../observability/logger.js';

export interface FastMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatTarget {
  baseUrl: string; // e.g. https://api.openai.com/v1 — NO trailing /chat/completions
  apiKey: string;
  model: string;
}

// One OpenAI-format chat completion. `extraBody` merges provider-specific fields
// (e.g. Ark's reasoning_effort). Throws on missing creds or any non-2xx.
export async function openaiChat(
  target: OpenAIChatTarget,
  messages: FastMessage[],
  // errorEvent labels the structured log; errorLabel labels the thrown Error message
  // (so each provider keeps its own operator-facing message, e.g. "Doubao API 404").
  opts?: { maxTokens?: number; extraBody?: Record<string, unknown>; timeoutMs?: number; errorEvent?: string; errorLabel?: string },
): Promise<string> {
  if (!target.apiKey || !target.model) throw new Error('openaiChat: missing apiKey or model');
  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    max_tokens: opts?.maxTokens ?? 350,
    ...(opts?.extraBody ?? {}),
  };
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
  });
  if (!res.ok) {
    const t = await res.text();
    log('error', opts?.errorEvent ?? 'openai_fast_error', { status: res.status, body: t.slice(0, 200) });
    throw new Error(`${opts?.errorLabel ?? 'OpenAI-format API'} ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

// True when OpenAI proper is configured (for the emotional gpt-* tier).
export function isOpenAIConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// Emotional-tier reply on OpenAI proper. Reads env at call time. Throws if unset.
export async function openaiFastReply(messages: FastMessage[], model: string, opts?: { maxTokens?: number }): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  return openaiChat({ baseUrl, apiKey, model }, messages, { maxTokens: opts?.maxTokens, errorEvent: 'openai_fast_error' });
}
