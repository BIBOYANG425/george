// src/agent/router.ts
//
// Front-line router (GEORGE_ROUTER_ENABLED, default-OFF). A two-step, explicit,
// loggable version of what the fast path does implicitly:
//
//   1. classifyRoute() — ONE cheap classifier call returns 'general' | 'full'.
//   2. 'general' → liteReply() answers as george-lite (his voice, NO tools) — a
//      reshape of fastReply with a confident "answer now" instruction.
//      'full'    → the caller falls through to the full tool-using agent.
//
// The classifier decides ONE thing: can this be answered right now from general
// knowledge / pure conversation with zero USC-local lookups and zero tools? If
// not — anything needing george's tools, USC/BIA/local data, or anything current —
// it routes 'full'. It LEANS FULL on any doubt, and on timeout / parse-failure /
// error (a wrong 'general' ships an ungrounded answer; a wrong 'full' only costs a
// few seconds). scanFabricationRisk inside fastReply is the second safety net: a
// george-lite draft that asserts an unverified USC specific returns null → full.
//
// When the flag is OFF the caller never reaches this module and the existing fast
// path runs verbatim (byte-identical). GEORGE_DISABLE_FAST_PATH suppresses BOTH the
// router and the fast path so the eval harness's topology A/B stays clean.
//
// Header last reviewed: 2026-07-17

import { callLightweightLLM } from './llm-providers.js';
import { fastReply, NEEDS_AGENT } from './fast-path.js';
import { getFlags } from '../flags.js';
import { log } from '../observability/logger.js';
import type { TurnTelemetry } from './session-store.js';

export type RouteVerdict = 'general' | 'full';

// Classifier timeout, re-read per call (matches getFlags()' re-read philosophy so
// a test can flip the env after import). callLightweightLLM's Claude path has NO
// timeout of its own, so without this a hung classifier would stall every turn.
function classifyTimeoutMs(): number {
  const v = parseInt(process.env.GEORGE_ROUTER_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 2000;
}

// The classifier prompt. Deliberately narrow: ONE JSON object, two labels, lean
// full. Kept verbatim-stable — it is the load-bearing routing surface.
const ROUTER_PROMPT = [
  'You are a routing classifier for George, a USC-focused bilingual iMessage',
  'assistant for Chinese international students. Read the LATEST user message',
  '(with the brief prior context) and decide which handler answers it. Output',
  'ONE JSON object and NOTHING else:',
  '{"route":"general"}  or  {"route":"full"}',
  '',
  'route = "general" ONLY when the message can be answered right now from general',
  'knowledge or is pure conversation, needing NO USC/local lookup and NO tool:',
  '- greetings, small talk, feelings, thanks, encouragement, opinions/vibes',
  '- general knowledge, explanations, definitions, math',
  '- writing / editing / coding / translation help',
  '- general (non-USC-specific) study or life advice',
  '',
  'route = "full" for ANYTHING that needs George\'s tools or data, is USC/BIA/local',
  'specific, or is time-sensitive. Non-exhaustive:',
  '- USC courses, professors, RMP ratings, programs, GEs, schedule planning',
  '- BIA or USC events, parties, club activities ("有啥活动/局")',
  '- places near campus, restaurants, study spots, dining, distance, travel time',
  '- DPS / safety / walkability ("晚上走回去安全吗")',
  '- roommates, sublets, housing, dorms, 找搭子 / squad / matching people',
  '- reminders ("提醒我…"), or anything about the user\'s saved memory/profile',
  '- immigration, visa, tuition/payment (Flywire/epay), campus services',
  '- anything local to LA/USC ("附近/学校/学长知道…")',
  '- anything current or recent your training may be stale on (new movies, shows,',
  '  news, prices, what\'s open now, "最近/最新")',
  '',
  'When in doubt, choose "full". A wrong "general" ships an ungrounded answer; a',
  'wrong "full" only costs a few seconds. Never explain. Output only the JSON.',
].join('\n');

// george-lite instruction — FAST_INSTRUCTION reframed. The classifier already
// vouched this is a general / no-lookup turn, so george answers CONFIDENTLY here
// instead of the fast path's timid "bail on anything factual". The OFFER-vs-ASSERT
// warmth-trap block is kept verbatim (it is the anti-fabrication core), plus a
// narrow NEEDS_AGENT escape so a classifier miss still recovers to the full agent.
const LITE_INSTRUCTION = [
  '# DIRECT RESPONDER MODE',
  'A router already decided this message needs no USC/local lookup and no tools —',
  "it's general conversation or general knowledge you already hold. Answer it now,",
  'fully and confidently, in voice (mirror their language, no markdown, short,',
  'follow every voice rule above). Do NOT stall, do NOT offer to "look it up", do',
  'NOT bail on something you plainly know: a definition, an explanation, general',
  'life/study advice, writing / coding / translation help, small talk, feelings.',
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
  'Mantra: offering to find = allowed; asserting it exists = forbidden.',
  '',
  '# ESCAPE HATCH',
  'If — despite the routing — this actually needs a specific USC/local fact, a',
  'current/recent lookup, or one of your tools (a course, professor, rating, event,',
  'place, price, hours, housing, immigration rule, or finding/matching a person),',
  `output EXACTLY this token and nothing else: ${NEEDS_AGENT}`,
].join('\n');

// Race a promise against a timeout. callLightweightLLM takes no abort signal, so on
// timeout the underlying call keeps running and its result is simply discarded.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`router_timeout_${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Parse the classifier's raw output into a verdict. Tolerant JSON slice first
// (first '{' … last '}', the house convention), bare-word regex fallback, and
// fail-closed to 'full'. Returns 'general' ONLY on an explicit general signal.
export function parseVerdict(raw: string): RouteVerdict {
  const text = (raw ?? '').trim();
  if (!text) return 'full';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { route?: unknown };
      if (typeof obj.route === 'string') {
        return obj.route.trim().toLowerCase() === 'general' ? 'general' : 'full';
      }
    } catch {
      // fall through to the regex fallback
    }
  }
  const lower = text.toLowerCase();
  if (/\bgeneral\b/.test(lower) && !/\bfull\b/.test(lower)) return 'general';
  return 'full';
}

// Classify one turn. Runs on the default fast tier (ignores per-user model
// overrides — routing is a system function, not user-tunable). Always logs the
// verdict + latency so misroutes are greppable regardless of DB column limits.
// Never throws: timeout / error → { verdict:'full' }.
export async function classifyRoute(args: { text: string; historyPrefix: string }): Promise<{ verdict: RouteVerdict; classifyMs: number }> {
  const started = Date.now();
  try {
    const raw = await withTimeout(
      callLightweightLLM(
        [
          { role: 'system', content: ROUTER_PROMPT },
          { role: 'user', content: `${args.historyPrefix}${args.text}` },
        ],
        { maxTokens: 24, jsonMode: true },
      ),
      classifyTimeoutMs(),
    );
    const verdict = parseVerdict(raw);
    const classifyMs = Date.now() - started;
    log('info', 'router_verdict', { verdict, classifyMs, sample: args.text.slice(0, 80) });
    return { verdict, classifyMs };
  } catch (err) {
    const classifyMs = Date.now() - started;
    log('warn', 'router_classify_failed', { error: (err as Error).message, classifyMs });
    return { verdict: 'full', classifyMs };
  }
}

// george-lite: a tool-less george-persona reply. Thin wrapper over fastReply with
// the confident LITE_INSTRUCTION. Inherits fastReply's provider routing, emotional
// model handling, and — critically — the scanFabricationRisk bail (returns null →
// caller runs the full agent). Returns null on bail / NEEDS_AGENT / empty / error.
export async function liteReply(args: {
  text: string;
  historyPrefix: string;
  profileBlock: string;
  recallBlock?: string;
  emotionalModel?: string | null;
}): Promise<string | null> {
  return fastReply({ ...args, instruction: LITE_INSTRUCTION });
}

// The cheap-path decision, extracted as a pure(ish) async function so it is unit-
// testable without the live SDK query() loop (mock llm-providers + fast-path). The
// caller yields based on the outcome:
//   { kind: 'answered' }    → yield result + telemetry, then return (turn is done)
//   { kind: 'fallthrough' } → proceed to the full agent; carry routeVerdict/classifyMs
export type CheapPathOutcome =
  | { kind: 'answered'; result: string; telemetry: TurnTelemetry }
  | { kind: 'fallthrough'; routeVerdict?: RouteVerdict; classifyMs?: number };

export async function decideCheapPath(args: {
  channel: string;
  text: string;
  historyPrefix: string;
  hasImages: boolean;
  profileBlock: string;
  recallBlock?: string;
  emotionalModel?: string | null;
}): Promise<CheapPathOutcome> {
  const flags = getFlags();

  // 1. Kill switch: neither router nor fast path — straight to the full agent.
  if (flags.disableFastPath) return { kind: 'fallthrough' };

  // 2. Router path (GEORGE_ROUTER_ENABLED).
  if (flags.routerEnabled) {
    // Images always reach the full agent (vision); george-lite is text-only.
    if (args.hasImages) return { kind: 'fallthrough', routeVerdict: 'full' };
    const { verdict, classifyMs } = await classifyRoute({ text: args.text, historyPrefix: args.historyPrefix });
    if (verdict === 'general') {
      const lite = await liteReply({
        text: args.text,
        historyPrefix: args.historyPrefix,
        profileBlock: args.profileBlock,
        recallBlock: args.recallBlock,
        emotionalModel: args.emotionalModel,
      });
      if (lite !== null) {
        return {
          kind: 'answered',
          result: lite,
          telemetry: { channel: args.channel, outcome: 'router_general', model: 'fast', tools: [], routeVerdict: 'general', classifyMs },
        };
      }
      // george-lite bailed (fabrication scan / NEEDS_AGENT escape) → full agent.
      return { kind: 'fallthrough', routeVerdict: 'full', classifyMs };
    }
    return { kind: 'fallthrough', routeVerdict: 'full', classifyMs };
  }

  // 3. Legacy fast path (router OFF) — preserved verbatim (byte-identical).
  const fast = args.hasImages
    ? null
    : await fastReply({
        text: args.text,
        historyPrefix: args.historyPrefix,
        profileBlock: args.profileBlock,
        recallBlock: args.recallBlock,
        emotionalModel: args.emotionalModel,
      });
  if (fast !== null) {
    return {
      kind: 'answered',
      result: fast,
      telemetry: { channel: args.channel, outcome: 'fast_path', model: 'fast', tools: [] },
    };
  }
  return { kind: 'fallthrough' };
}
