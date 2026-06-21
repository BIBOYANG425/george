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
import { config } from '../config.js';
import { scanFabricationRisk } from './fast-path-guard.js';

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
  '# OFFER vs ASSERT (the warmth trap)',
  'Being warm does NOT license naming a specific thing you have not verified.',
  'Offering to look it up is fine and stays warm:',
  '    "想吃粤菜的话我帮你扒一下附近靠谱的，要不要"',
  '    "三点多能 walk-in 的真不多了🥲 我帮你查查这会儿还开着的"',
  'Asserting a specific shop / gathering / opening status / course / price as if you',
  'know it is FORBIDDEN; those are facts you must look up, never guess:',
  '    "附近有几家粤菜馆能吃出家里味道"   "bia 这周有个四人火锅局"',
  '    "楼下 in-n-out 现在还开着"          "writ150 选 Smith，评分 4.8"',
  'Mantra: offering to find = allowed; asserting it exists = forbidden. If the warm',
  `reply would need such a detail, either output ${NEEDS_AGENT} or stay warm WITHOUT`,
  'the unverified detail ("陪你扯扯淡" / "我帮你查查这点还开着的地儿").',
  '',
  `CRITICAL: never stall on a FACTUAL question. If the message asks for a fact and`,
  `your reply would be "let me check" / "give me a sec" / a bare promise to find out,`,
  `you need the tools, so output ${NEEDS_AGENT}. (A gentle offer on a pure feelings`,
  `turn, "我帮你查查，要不要", is care, not a stall, and is fine SO LONG AS it asserts`,
  `no specific shop / event / hour / course / price.) Either answer fully now, or`,
  `output ${NEEDS_AGENT}.`,
].join('\n');

// Returns George's reply for a no-lookup message, or null to signal "run the
// full agent" (the message needs tools, or the fast call failed).
//
// `recallBlock` is the P6 observational-memory block ("## THINGS YOU REMEMBER"),
// pre-fetched once per turn by the caller (recallForTurn). '' when
// GEORGE_RECALL_ENABLED is unset, so the OFF path is byte-for-byte unchanged. It is
// placed right after the profile block so the fast model sees identity + memories
// together, matching the full-agent paths.
export async function fastReply(args: {
  text: string;
  historyPrefix: string;
  profileBlock: string;
  recallBlock?: string;
}): Promise<string | null> {
  const system = [MASTER_PROMPT, renderDateBlock(), renderMoodBlock(), args.profileBlock, args.recallBlock, FAST_INSTRUCTION]
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

    // Code-level anti-fabrication gate. The model is told never to invent, but it
    // does (Doubao especially), reaching for a concrete shop / gathering / hour /
    // course / price to sound warm. Trust the SCAN, not the model's self-policing:
    // any asserted specific fact bails to the grounded full agent. Recall-biased (a
    // false bail just costs the few seconds of a full-agent turn); offer-framed hits
    // ("我帮你查查…") are suppressed inside the scanner. Kill-switch:
    // FASTPATH_FABRICATION_GUARD=false.
    if (config.fastPathFabricationGuard) {
      const hits = scanFabricationRisk(text);
      if (hits.length) {
        log('info', 'fast_path_fabrication_bail', {
          ids: hits.map((h) => h.id),
          sample: hits[0].match,
        });
        return null;
      }
    }

    return text;
  } catch (err) {
    // Never block a reply: any failure falls through to the full agent.
    log('warn', 'fast_path_failed', { error: (err as Error).message });
    return null;
  }
}
