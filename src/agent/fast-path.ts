// src/agent/fast-path.ts
//
// Fast path for the no-lookup majority. A greeting routed through the full
// orchestrator engine took ~53s (multi-hop dispatch + per-hop extended thinking).
// Most messages — greetings, small talk, feelings, thanks — need zero tools and
// zero dispatch. This answers them with ONE direct call on the lightweight tier
// (Kimi when KIMI_API_KEY is set, else the Claude fast fallback), ~2-3s, and bails
// to the full agent for anything that needs a real fact. The orchestrator and the
// two sub-agents stay on Claude — only this no-lookup reply runs on the cheap tier.
//
// Safety: anti-fabrication is preserved by being CONSERVATIVE. The model is told
// to emit NEEDS_AGENT (and nothing else) for anything factual or uncertain; the
// caller then runs the full tool-using agent. The fast path never invents facts.

import { callLightweightLLM } from './llm-providers.js';
import { doubaoChat, isDoubaoConfigured } from './doubao-client.js';
import { MASTER_PROMPT } from './agents.config.js';
import { renderMoodBlock, renderDateBlock } from './calendar-mood.js';
import { log } from '../observability/logger.js';

const NEEDS_AGENT = 'NEEDS_AGENT';

const FAST_INSTRUCTION = [
  '# FAST RESPONDER MODE',
  'You handle ONLY messages that need no lookup. If the latest message can be',
  'answered right now with zero external facts — a greeting, small talk, feelings,',
  'thanks, encouragement, or vibes/opinions you already hold — reply in voice',
  '(mirror their language, no markdown, short, follow every voice rule above).',
  '',
  "If answering would need ANY fact you'd otherwise look up — a specific course,",
  'professor, rating, event, place, price, date, housing, immigration rule,',
  'finding/matching people, OR anything current or recent (new/recent movies,',
  "shows, music, news, what's trending or popular now, this week's events, 最近 /",
  '最新 anything) which your training is too old to know — output EXACTLY',
  `this token and nothing else: ${NEEDS_AGENT}`,
  '',
  `When in doubt, output ${NEEDS_AGENT}. Never invent a fact to avoid bailing.`,
  '',
  `CRITICAL: never stall. Do NOT reply with "let me check", "give me a sec",`,
  `"i'll look it up", or any promise to find out — that means you need the tools,`,
  `so output ${NEEDS_AGENT} instead. Either answer fully now, or output ${NEEDS_AGENT}.`,
].join('\n');

// Returns George's reply for a no-lookup message, or null to signal "run the
// full agent" (the message needs tools, or the fast call failed).
export async function fastReply(args: {
  text: string;
  historyPrefix: string;
  profileBlock: string;
}): Promise<string | null> {
  const system = [MASTER_PROMPT, renderDateBlock(), renderMoodBlock(), args.profileBlock, FAST_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');
  try {
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: `${args.historyPrefix}${args.text}` },
    ];
    // Emotional/小聊天 turns run on Doubao (中文情绪价值) when configured — a single
    // no-tool OpenAI-format call. On any Doubao failure, fall back to the existing
    // lightweight tier (Kimi/Claude) so a Doubao outage never pushes casual chat to
    // the slow full agent. No Doubao → the original lightweight path, unchanged.
    let raw: string;
    if (isDoubaoConfigured()) {
      try {
        raw = await doubaoChat(messages, { maxTokens: 350 });
      } catch (e) {
        log('warn', 'fast_path_doubao_fallback', { error: (e as Error).message });
        raw = await callLightweightLLM(messages, { maxTokens: 350 });
      }
    } else {
      // Lightweight tier: Kimi (moonshot) when KIMI_API_KEY is set, else the Claude
      // fast fallback (config.models.fast). No tools, one turn, ~2-3s.
      raw = await callLightweightLLM(messages, { maxTokens: 350 });
    }
    const text = (raw ?? '').trim();
    if (!text || text.toUpperCase().includes(NEEDS_AGENT)) return null;
    return text;
  } catch (err) {
    // Never block a reply: any failure falls through to the full agent.
    log('warn', 'fast_path_failed', { error: (err as Error).message });
    return null;
  }
}
