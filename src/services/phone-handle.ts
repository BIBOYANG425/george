// src/services/phone-handle.ts
// Normalizes an iMessage sender handle so a phone matches the canonical E.164
// format stored in students.imessage_id. This delegates phone normalization to
// the SINGLE shared canonicalizer (phone-canonical.ts, spec §3) so george's
// handle path and bia-roommate's signup path produce identical E.164 strings and
// can't drift (the drift caused the +86 -> +853 identity fork in prod).
//
// Pass-through rule: only phone-shaped handles (a leading "+" or all/mostly
// digits) are canonicalized. Everything else — emails, "web-anon",
// "relay-smoke", a WeChat openid, any non-numeric handle — is returned
// UNCHANGED. If a phone-shaped handle fails to canonicalize (ok:false), it is
// also returned unchanged rather than dropped, so no inbound handle is ever lost.
// Pure, no I/O.
//
// Header last reviewed: 2026-06-23

import { canonicalizePhone } from './phone-canonical.js'

export function normalizeHandle(raw: string): string {
  const s = (raw ?? '').trim()
  if (s === '') return ''
  if (s.includes('@')) return s.toLowerCase()

  // Phone-shaped? A leading "+", or a value that is all/mostly digits (allowing
  // the usual phone punctuation: spaces, dashes, parens, dots). Anything else
  // (e.g. a WeChat openid, "web-anon", "relay-smoke") is not a phone and passes
  // through untouched.
  if (!looksLikePhone(s)) return raw

  // george has no country dropdown, so a bare national number with no leading
  // "+" is interpreted as US/North-American (the prior behavior and the dominant
  // inbound for this product). An explicit "+" or a full foreign number's own
  // country code still wins inside canonicalizePhone, so this only affects
  // genuinely bare local numbers. Production handles arrive as E.164 anyway.
  const result = canonicalizePhone(s, { defaultCountry: 'US' })
  if (result.ok) return result.e164

  // Phone-shaped but not canonicalizable: pass through unchanged, never drop.
  return raw
}

// A handle is phone-shaped if it starts with "+", or if — after removing common
// phone punctuation — it is non-empty and entirely digits.
function looksLikePhone(s: string): boolean {
  if (s.startsWith('+')) return true
  const digitsOnly = s.replace(/[\s()\-.]/g, '')
  return digitsOnly.length > 0 && /^\d+$/.test(digitsOnly)
}
