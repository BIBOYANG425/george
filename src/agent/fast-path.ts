// src/agent/fast-path.ts
//
// Fast path for the no-lookup majority. A greeting routed through the full
// orchestrator engine took ~53s (multi-hop dispatch + per-hop extended thinking).
// Most messages — greetings, small talk, feelings, thanks — need zero tools and
// zero dispatch. This answers them with ONE direct flash call (thinking disabled),
// ~2-3s, and bails to the full agent for anything that needs a real fact.
//
// Safety: anti-fabrication is preserved by being CONSERVATIVE. The model is told
// to emit NEEDS_AGENT (and nothing else) for anything factual or uncertain; the
// caller then runs the full tool-using agent. The fast path never invents facts.

import { getClaudeClient } from './llm-providers.js';
import { config } from '../config.js';
import { MASTER_PROMPT } from './agents.config.js';
import { renderMoodBlock } from './calendar-mood.js';
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
  'professor, rating, event, place, price, date, housing, immigration rule, or',
  "finding/matching people, or anything you are not sure about — output EXACTLY",
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
  const system = [MASTER_PROMPT, renderMoodBlock(), args.profileBlock, FAST_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');
  try {
    const client = getClaudeClient();
    const resp = await client.messages.create({
      model: config.models.fast,
      max_tokens: 350,
      system,
      // Disable extended thinking — on the fast tier it adds ~7s/call for no gain
      // on small talk. (DeepSeek-v4 defaults thinking ON; Claude is off by default.)
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: `${args.historyPrefix}${args.text}` }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    const text = (block && 'text' in block ? block.text : '').trim();
    if (!text || text.toUpperCase().includes(NEEDS_AGENT)) return null;
    return text;
  } catch (err) {
    // Never block a reply: any failure falls through to the full agent.
    log('warn', 'fast_path_failed', { error: (err as Error).message });
    return null;
  }
}
