// src/agent/voice-guard.ts
//
// Slim voice hard-bans that survive the bia-lore drop. The old bia-lore.ts
// carried a heavy anti-slop linter (≤2 emoji, ≤600 chars, a long Chinese
// signature-phrase + AI-slop list); that is gone — voice now comes from
// prompts/master.md. But two rules stay HARD-banned and are enforced on composed
// proactive messages (the re-reach tone variant), not just stated in the prompt:
//
//   1. No em / en dash (a classic LLM tell). master.md "No em dashes."
//   2. No negation-contrast ("it's not X, it's Y" / 不是…而是) — the rhetorical
//      pivot. master.md "No negation-contrast structure."
//
// These are kept as regexes because they are clean to detect and are the two
// tells Bobby flagged as must-stay-banned. Everything else is prompt-level.

const BANS: Array<{ id: string; rx: RegExp }> = [
  { id: 'em_dash', rx: /[—–]/ },
  // Chinese negation-pivot: 不是X，而是Y. Allow an internal comma (it's part of
  // the structure) but not a sentence-ender, so it doesn't span sentences.
  { id: 'negation_contrast_zh', rx: /不是[^。！？\n]{0,30}而是/ },
  // English "it's not X, it's Y" — require the comma pivot to stay conservative
  // and avoid flagging factual "it's not ready, it's still loading" runs.
  { id: 'negation_contrast_en', rx: /\bit'?s not\b[^.!?\n]{1,40},\s*it('?s| is)\b/i },
]

// Returns the ids of any hard-banned voice tells in `text` ([] = clean).
export function bannedVoiceHits(text: string): string[] {
  return BANS.filter((b) => b.rx.test(text)).map((b) => b.id)
}
