// src/agent/doubao-client.ts
//
// Doubao (豆包 / 火山方舟 Ark) chat client via Ark's OpenAI-compatible endpoint
// (/api/v3). Used by the FAST PATH — the no-tool emotional/小聊天 turns (greetings,
// feelings, comfort, vibes) where Doubao's Chinese warmth ("情绪价值") is the win.
// Those turns are a single no-tool LLM call, so the OpenAI format fits directly —
// no Anthropic-protocol gateway needed. Factual/tool turns stay on the main agent.
//
// Reads process.env at call time (dynamic + unit-testable). seed-lite is a
// thinking model, so reasoning_effort defaults to 'minimal' to keep the fast path
// fast (~2-3s); override via DOUBAO_REASONING_EFFORT.

import { log } from '../observability/logger.js';

export interface DoubaoMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export function isDoubaoConfigured(): boolean {
  return !!(process.env.DOUBAO_API_KEY && process.env.DOUBAO_MODEL);
}

// One OpenAI-format chat completion against Ark. Throws on any non-2xx so the
// caller can fall back to the existing lightweight tier.
export async function doubaoChat(messages: DoubaoMessage[], opts?: { maxTokens?: number }): Promise<string> {
  const apiKey = process.env.DOUBAO_API_KEY;
  const model = process.env.DOUBAO_MODEL;
  if (!apiKey || !model) throw new Error('Doubao not configured (DOUBAO_API_KEY / DOUBAO_MODEL)');
  const baseUrl = process.env.DOUBAO_BASE_URL || DEFAULT_BASE_URL;
  const effort = process.env.DOUBAO_REASONING_EFFORT || 'minimal';

  const body: Record<string, unknown> = { model, messages, max_tokens: opts?.maxTokens ?? 350 };
  // reasoning_effort applies to thinking models (seed-1.6 family). Harmless on
  // non-thinking ids; unset DOUBAO_REASONING_EFFORT to omit it.
  if (effort) body.reasoning_effort = effort;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const t = await res.text();
    log('error', 'doubao_api_error', { status: res.status, body: t.slice(0, 200) });
    throw new Error(`Doubao API ${res.status}: ${t.slice(0, 200)}`);
  }
  // Thinking models return the answer in message.content (reasoning lives in a
  // separate reasoning_content field we don't surface).
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}
