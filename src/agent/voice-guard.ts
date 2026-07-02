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

// Strip "Sources:"-style citation footers and bare-URL lines from an outgoing
// reply. The 2026-07-02 100-persona sim measured the model appending footers to
// 56% of slim-arm replies (including degenerate "Sources: No sources needed"
// stamps after bare emoji) DESPITE webSearchGuidance explicitly banning them —
// prompt-only enforcement loses under search-result pressure, so this is code.
// The footer is a terminal block: everything from a line starting with
// Sources:/来源:/参考: to end of text goes; lines that are only a bare URL
// (footer remnants / md-link leftovers) go too.
export function stripSourcesFooter(text: string): string {
  if (!text) return text
  let out = text.replace(/(^|\n)\s*[-•*]?\s*(sources?|来源|参考(?:资料)?)\s*[:：][\s\S]*$/i, '$1')
  out = out.replace(/^[ \t]*(?:[-•*][ \t]*)?https?:\/\/\S+[ \t]*\n?/gm, '')
  return out.replace(/\n{3,}/g, '\n\n').trimEnd()
}

// Deterministic em/en-dash REWRITE for outgoing reactive replies. The prompt ban
// alone loses to the model's dash habit ~35% of conversations (measured on the
// 2026-07-02 100-persona sim, identical rate on both architectures), and
// bannedVoiceHits only ever guarded proactive sends. Applied at the
// parseControlTokens choke point so every reactive surface is covered.
//
// Context-aware replacements, most-specific first:
//   digit–digit ranges        -> hyphen        (9–5 stays a range)
//   CJK on either side        -> ，            (texting register)
//   latin, spaced " — "       -> ", "          (clause link survives)
//   latin, unspaced word—word -> ", "
//   anything left             -> ", " fallback, then tidy doubled separators
//
// Negation-contrast stays detect-only (rewriting it needs a writer, not a regex).
export function sanitizeDashes(text: string): string {
  if (!/[—–]/.test(text)) return text
  const CJK = '一-鿿　-〿＀-￯'
  let out = text
  out = out.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2')
  out = out.replace(new RegExp(`([${CJK}])\\s*[—–]+\\s*`, 'g'), '$1，')
  out = out.replace(new RegExp(`\\s*[—–]+\\s*([${CJK}])`, 'g'), '，$1')
  out = out.replace(/\s+[—–]+\s+/g, ', ')
  out = out.replace(/[—–]+/g, ', ')
  // Tidy artifacts: doubled commas/spaces, comma before punctuation, 中英 doubles.
  out = out.replace(/，\s*，/g, '，').replace(/,\s*,/g, ',').replace(/，\s*([。！？])/g, '$1')
  out = out.replace(/,\s*([.!?])/g, '$1').replace(/ {2,}/g, ' ')
  return out
}
