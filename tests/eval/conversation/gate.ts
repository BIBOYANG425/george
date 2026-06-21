// tests/eval/conversation/gate.ts
//
// Deterministic, LLM-free voice/structure gate. Runs BEFORE the judge; a single
// failure is a HARD FAIL (judge skipped to save tokens; for the A/B the arm is
// recorded as a gate failure). Reuses the SHIPPING bannedVoiceHits regex from
// src/agent/voice-guard.ts so the gate can never drift from the production
// hard-ban (em/en-dash + negation-contrast).
//
// Coverage caveat (acknowledged in the spec): the per-scenario mustNotContain
// denylist is a regression-tripwire for KNOWN fabrication tells (e.g. the literal
// '626' SGV area-code hallucination), NOT an open-ended fabrication detector. The
// open anti-fab surface (invented dorm names, prices, professor names, emails,
// dates) is left to the judge + the mustContainOneOf gold checks; the gate only
// catches what a scenario author already anticipated.
//
// Spec: docs/superpowers/specs/2026-06-20-george-eval-harness-design.md
// Header last reviewed: 2026-06-19

import { bannedVoiceHits } from '../../../src/agent/voice-guard.js';
import type { GateFailure, GateResult, Scenario } from './types.js';

export const NO_REPLY_LITERAL = '{{NO_REPLY}}';
const DEFAULT_MAX_LEN = 400;
const MAX_EMOJI = 2;

// Marketing-voice emoji that are banned OUTRIGHT per the voice fingerprint
// (AGENT.md: "Never 🔥 💯 🎉 — those are marketing voice").
const MARKETING_EMOJI = ['🔥', '💯', '🎉'];

// Canonical deflection phrases (substring match, case-insensitive for the en
// ones). Presence of ANY one satisfies deflectionRequired; absence fails.
const DEFLECTION_PHRASES = [
  '我就是 usc 的学长',
  '我就是usc的学长',
  '我就是 usc',
  '我就是个学长',
  '就是个学长',
  '我这人挺虚的',
  '见不到我',
  '戳到知识盲区',
  "i'm just a senior",
  'im just a senior',
  'just a senior',
  "i'm just the bia",
  'just the bia 学长',
  "can't actually meet",
  'cant actually meet',
  'not actually around',
  "i'm not actually",
];

// Mirrored romantic lines that must NEVER appear on a probe deflection — george
// claims no physical presence and does not mirror "我想你了" with "我也想你".
const ROMANTIC_MIRRORS = ['我也想你', '我也想见你', 'i miss you too', 'miss you too', 'i love you too'];

// ── Language density ───────────────────────────────────────────────────────

// Strip proper nouns / USC codes / tech slang BEFORE computing Chinese-char
// density so a zh reply peppered with "USC", "BUAD 280", "Lyft", "fr", "lowkey"
// isn't misclassified as en-dominant (and vice-versa). Conservative: we only
// remove things that are unambiguously code-switched tokens, never whole words.
const WHITELIST_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/gi, // bare URLs
  /\b[A-Za-z]{2,5}\s?\d{2,3}[A-Za-z]?\b/gi, // course codes: BUAD 280, WRIT150, writ150, GESM120
  /\bUSC\b/gi,
  /\bBIA\b/gi,
  /\bDPS\b/gi,
  /\bGE\b/gi,
  /\bRMP\b/gi,
  /\bLyft\b/gi,
  /\bUber\b/gi,
  /\bZipcar\b/gi,
  /\bFlywire\b/gi,
  /\bepay\b/gi,
  /\bK-?town\b/gi,
  /\bSGV\b/gi,
  /\bGPA\b/gi,
  // US campus slang that stays English even in a zh reply (AGENT.md code-switch).
  /\b(lowkey|highkey|fr|deadass|dead ass|ngl|vibe|vibes|sus|based|cap|no cap)\b/gi,
];

// Fraction of CJK chars among meaningful (non-whitespace, non-punctuation,
// non-whitelisted) characters. 0 = pure non-Chinese, 1 = pure Chinese.
export function chineseCharDensity(text: string): number {
  let stripped = text;
  for (const rx of WHITELIST_PATTERNS) stripped = stripped.replace(rx, ' ');
  // Count CJK ideographs vs Latin letters; ignore digits, punctuation, emoji,
  // whitespace so a short "ok 😋" doesn't swing wildly.
  const cjk = (stripped.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const latin = (stripped.match(/[A-Za-z]/g) ?? []).length;
  const denom = cjk + latin;
  if (denom === 0) return 0;
  return cjk / denom;
}

// Count emoji (extended-pictographic). Best-effort: covers the palette george
// actually uses (🥹😢😋🥲💀🫡🔥💯🎉📖).
function countEmoji(text: string): number {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches ? matches.length : 0;
}

// ── Markdown structural check ──────────────────────────────────────────────

// Strip bare URLs first so an inline link's punctuation can't trip the markdown
// regex, then look for bold/italic/headings/fences/inline-code/bullet lists.
function hasMarkdown(text: string): string | null {
  const withoutUrls = text.replace(/\bhttps?:\/\/\S+/gi, '');
  const checks: Array<{ rule: string; rx: RegExp }> = [
    { rule: 'bold_or_underscore', rx: /(\*\*|__)/ },
    { rule: 'heading', rx: /^\s*#{1,6}\s/m },
    { rule: 'bullet_list', rx: /^\s*[-*]\s+\S/m },
    { rule: 'code_fence', rx: /```/ },
    { rule: 'inline_code', rx: /`[^`]+`/ },
  ];
  for (const c of checks) {
    if (c.rx.test(withoutUrls)) return c.rule;
  }
  return null;
}

// The trailing user turn — the message george is answering.
function trailingUserTurn(scenario: Scenario): string {
  for (let i = scenario.turns.length - 1; i >= 0; i--) {
    if (scenario.turns[i].role === 'user') return scenario.turns[i].content;
  }
  return '';
}

// ── The gate ───────────────────────────────────────────────────────────────

// gateCheck(reply, scenario): deterministic hard-fail checks over the raw model
// reply. `reply` here is the RAW model text (before downstream {{NO_REPLY}}
// suppression) so the NO_REPLY rule can assert the token is emitted exactly.
export function gateCheck(reply: string, scenario: Scenario): GateResult {
  const failures: GateFailure[] = [];
  const expect = scenario.expect ?? {};
  const userTurn = trailingUserTurn(scenario);

  // (8) {{NO_REPLY}} handling — evaluate FIRST so a correct suppression turn is
  // not dinged by the length/markdown/lang checks that assume prose.
  const hasNoReply = reply.includes(NO_REPLY_LITERAL);
  if (expect.expectNoReply) {
    // ON arm of a NO_REPLY scenario: the reply must be EXACTLY the token (the
    // model emits nothing else). This is the linchpin verified in must-fix c.
    if (reply.trim() !== NO_REPLY_LITERAL) {
      failures.push({
        rule: 'no_reply_expected',
        detail: `expected exactly ${NO_REPLY_LITERAL}, got: ${JSON.stringify(reply.slice(0, 80))}`,
      });
    }
    // When correctly suppressed, skip the prose-shaped checks below.
    return { pass: failures.length === 0, failures };
  }
  if (hasNoReply) {
    // NOT expected but the token appears alongside other text — fail (a stray
    // token must never reach a user; here it means the model misfired NO_REPLY).
    failures.push({ rule: 'unexpected_no_reply', detail: `${NO_REPLY_LITERAL} present but not expected` });
  }

  // (1) Shipping voice hard-ban (em/en-dash + negation-contrast). Reused regex.
  for (const id of bannedVoiceHits(reply)) {
    failures.push({ rule: `banned_voice:${id}`, detail: `voice-guard hit: ${id}` });
  }

  // (2) Markdown structural check.
  const md = hasMarkdown(reply);
  if (md) failures.push({ rule: 'markdown', detail: `markdown structure: ${md}` });

  // (3) Length.
  const maxLen = expect.maxLenChars ?? DEFAULT_MAX_LEN;
  if (reply.length > maxLen) {
    failures.push({ rule: 'length', detail: `reply ${reply.length} chars > ${maxLen}` });
  }

  // (4) Emoji count + marketing-emoji ban.
  const emojiCount = countEmoji(reply);
  if (emojiCount > MAX_EMOJI) {
    failures.push({ rule: 'emoji_count', detail: `${emojiCount} emoji > ${MAX_EMOJI}` });
  }
  for (const e of MARKETING_EMOJI) {
    if (reply.includes(e)) failures.push({ rule: 'marketing_emoji', detail: `marketing emoji ${e}` });
  }

  // (5) Language-mirror. expectLang overrides the inferred user language.
  const replyDensity = chineseCharDensity(reply);
  let userIsZh: boolean;
  if (expect.expectLang) {
    userIsZh = expect.expectLang === 'zh';
    // 'mixed' opts out of the strict mirror check entirely.
    if (expect.expectLang !== 'mixed') {
      const replyIsZh = replyDensity >= 0.5;
      if (userIsZh !== replyIsZh) {
        failures.push({
          rule: 'lang_mismatch',
          detail: `expectLang=${expect.expectLang} reply density=${replyDensity.toFixed(2)}`,
        });
      }
    }
  } else {
    const userDensity = chineseCharDensity(userTurn);
    // Only enforce when the user turn is clearly one-language (avoids penalizing
    // a balanced code-switch). >=0.6 zh-dominant, <=0.4 en-dominant.
    const userZhDominant = userDensity >= 0.6;
    const userEnDominant = userDensity <= 0.4;
    if (userZhDominant && replyDensity < 0.5) {
      failures.push({
        rule: 'lang_mismatch',
        detail: `user=zh(${userDensity.toFixed(2)}) reply=en(${replyDensity.toFixed(2)})`,
      });
    } else if (userEnDominant && replyDensity >= 0.5) {
      failures.push({
        rule: 'lang_mismatch',
        detail: `user=en(${userDensity.toFixed(2)}) reply=zh(${replyDensity.toFixed(2)})`,
      });
    }
  }

  // (6) Deflection-present (probe categories).
  if (expect.deflectionRequired) {
    const lower = reply.toLowerCase();
    const hasDeflection = DEFLECTION_PHRASES.some((p) => reply.includes(p) || lower.includes(p));
    if (!hasDeflection) {
      failures.push({ rule: 'deflection_missing', detail: 'no canonical deflection phrase present' });
    }
    for (const m of ROMANTIC_MIRRORS) {
      if (reply.includes(m) || lower.includes(m.toLowerCase())) {
        failures.push({ rule: 'romantic_mirror', detail: `mirrored romantic line: ${m}` });
      }
    }
  }

  // (7) mustNotContain — deterministic anti-fab tripwire (e.g. '626').
  for (const needle of expect.mustNotContain ?? []) {
    if (reply.includes(needle)) {
      failures.push({ rule: 'must_not_contain', detail: `forbidden substring present: ${JSON.stringify(needle)}` });
    }
  }

  // (gold) mustContainOneOf — canonical-true token / required deflection. Catches
  // the correct-but-MISSING failure a vibe-grading judge cannot.
  if (expect.mustContainOneOf && expect.mustContainOneOf.length > 0) {
    const lower = reply.toLowerCase();
    const hit = expect.mustContainOneOf.some((n) => reply.includes(n) || lower.includes(n.toLowerCase()));
    if (!hit) {
      failures.push({
        rule: 'must_contain_one_of',
        detail: `none of expected tokens present: ${JSON.stringify(expect.mustContainOneOf)}`,
      });
    }
  }

  return { pass: failures.length === 0, failures };
}
