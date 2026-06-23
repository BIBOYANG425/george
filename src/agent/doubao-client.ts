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

import { openaiChat, type FastMessage } from './openai-fast-client.js';

// Doubao messages are OpenAI-format chat messages (kept as a named export for
// existing importers).
export type DoubaoMessage = FastMessage;

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export function isDoubaoConfigured(): boolean {
  return !!(process.env.DOUBAO_API_KEY && process.env.DOUBAO_MODEL);
}

// One OpenAI-format chat completion against Ark, via the shared openaiChat primitive.
// Throws on any non-2xx so the caller can fall back to the lightweight tier.
//
// `opts.model` lets a per-user emotional override pick a specific Ark id; it defaults
// to DOUBAO_MODEL (the global fast-path model) so the OFF/default path is unchanged.
export async function doubaoChat(messages: DoubaoMessage[], opts?: { maxTokens?: number; model?: string }): Promise<string> {
  const apiKey = process.env.DOUBAO_API_KEY;
  const model = opts?.model || process.env.DOUBAO_MODEL;
  if (!apiKey || !model) throw new Error('Doubao not configured (DOUBAO_API_KEY / DOUBAO_MODEL)');
  const baseUrl = process.env.DOUBAO_BASE_URL || DEFAULT_BASE_URL;
  // reasoning_effort applies to thinking models (seed-1.6 family). Harmless on
  // non-thinking ids; unset DOUBAO_REASONING_EFFORT to omit it.
  const effort = process.env.DOUBAO_REASONING_EFFORT || 'minimal';
  return openaiChat({ baseUrl, apiKey, model }, messages, {
    maxTokens: opts?.maxTokens,
    extraBody: effort ? { reasoning_effort: effort } : undefined,
    errorEvent: 'doubao_api_error',
    errorLabel: 'Doubao API',
  });
}
