// src/services/phone-canonical.ts
// THE single deterministic phone canonicalizer (Phase 2 of the identity-
// reconciliation spec, §3). One pure function turns any user-typed phone into
// a libphonenumber-validated E.164 string, so george (normalizeHandle) and
// bia-roommate (signup capture / normalizePhone) can never drift. Drift is what
// caused the +86 -> +853 identity fork in prod.
//
// STANDALONE BY CONTRACT: this file imports ONLY `libphonenumber-js`. It has
// zero george-internal imports so bia-roommate copies it verbatim. Do not add
// any local imports here — the parity test vector (phone-canonical.vector.json)
// is the cross-repo no-drift contract that both repos run against this code.
//
// Header last reviewed: 2026-06-23

import { parsePhoneNumberFromString, isValidPhoneNumber } from 'libphonenumber-js'

export type CanonResult =
  | { ok: true; e164: string }
  | { ok: false; e164: null; reason: string }

/**
 * Canonicalize a user-typed phone string to a single E.164 form.
 *
 * Rules (spec §3, deterministic, identical in both repos):
 *  1. Trim; empty -> {ok:false, reason:'empty'}.
 *  2. Reduce to digits + a single leading '+' (the international '00' prefix
 *     becomes that leading '+', so 008615522499291 -> +8615522499291).
 *  3. If it starts with '+', parse WITHOUT a default country; valid -> E.164.
 *  4. If no leading '+' and a dialCode/defaultCountry is supplied: FIRST try
 *     parsing the raw national digits standalone (as if they already encode a
 *     country). If that yields a valid number whose calling code != the
 *     supplied dialCode's calling code, TRUST THE PARSED NUMBER. Otherwise
 *     prepend the dial code and parse.
 *  5. Validate with isValidPhoneNumber; invalid -> {ok:false, reason:'invalid'}.
 *  6. Output is ALWAYS libphonenumber's .number (E.164). NEVER a blind
 *     `${dialCode}${digits}` concat.
 */
export function canonicalizePhone(
  input: string,
  opts?: { defaultCountry?: string; dialCode?: string },
): CanonResult {
  // 1. Trim.
  const trimmed = (input ?? '').trim()
  if (trimmed === '') return { ok: false, e164: null, reason: 'empty' }

  // 2. Reduce to digits + a single leading '+'. We only honor a '+' that leads
  //    the value; embedded '+' (e.g. "1+2") is dropped as junk.
  let cleaned = ''
  let seenPlus = false
  for (const ch of trimmed) {
    if (ch >= '0' && ch <= '9') cleaned += ch
    else if (ch === '+' && !seenPlus && cleaned === '') {
      cleaned = '+'
      seenPlus = true
    }
  }
  // The international '00' dialing prefix is equivalent to a leading '+'.
  if (!cleaned.startsWith('+') && cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`
  }
  if (cleaned === '' || cleaned === '+') {
    return { ok: false, e164: null, reason: 'invalid' }
  }

  // 3. Already has a country code (leading '+'): parse without a default country.
  if (cleaned.startsWith('+')) {
    return parseAndValidate(cleaned)
  }

  // 4. National digits with a supplied dial code / default country.
  const dialCode = opts?.dialCode
  const defaultCountry = opts?.defaultCountry
  if (dialCode || defaultCountry) {
    // 4a. Trust-the-number guard (the +86/+853 class): the user typed a FULL
    //     foreign number whose digits already encode a country (e.g. the +86
    //     number "8615522499291") but the dropdown said something else (+853).
    //     Parse the raw national digits standalone; if they form a valid number
    //     whose calling code differs from the supplied dial code's calling code,
    //     the typed number wins over the dropdown.
    if (dialCode) {
      const standalone = parsePhoneNumberFromString(`+${cleaned}`)
      const suppliedCc = digitsOnly(dialCode)
      if (
        standalone &&
        standalone.isValid() &&
        standalone.countryCallingCode !== suppliedCc
      ) {
        return { ok: true, e164: standalone.number }
      }
    }

    // 4b. Normal path: prepend the dial code (digits only, leading '+' stripped)
    //     and parse, or fall back to the default country.
    if (dialCode) {
      return parseAndValidate(`+${digitsOnly(dialCode)}${cleaned}`)
    }

    // defaultCountry-only path. Same trust-the-number idea as 4a: if the raw
    // national digits already form a valid number for ANOTHER country (e.g. a
    // full +86 number "8613812345678" typed with defaultCountry 'US'), trust
    // that over the default. Only when the standalone parse is NOT a valid
    // foreign number do we attach the default country (so genuine bare locals
    // like "2135550142" still resolve to +1...).
    const standaloneDc = parsePhoneNumberFromString(`+${cleaned}`)
    if (
      standaloneDc &&
      standaloneDc.isValid() &&
      standaloneDc.country !== defaultCountry
    ) {
      return { ok: true, e164: standaloneDc.number }
    }
    const pn = parsePhoneNumberFromString(cleaned, defaultCountry as never)
    if (pn && pn.isValid()) return { ok: true, e164: pn.number }
    return { ok: false, e164: null, reason: 'invalid' }
  }

  // No country context at all: the bare national digits cannot be canonicalized
  // deterministically. Treat as '+digits' (some inputs already carry a country
  // code, e.g. "8615522499291") and validate; reject if that is not a real number.
  return parseAndValidate(`+${cleaned}`)
}

function parseAndValidate(e164ish: string): CanonResult {
  if (!isValidPhoneNumber(e164ish)) {
    return { ok: false, e164: null, reason: 'invalid' }
  }
  const pn = parsePhoneNumberFromString(e164ish)
  if (!pn || !pn.isValid()) {
    return { ok: false, e164: null, reason: 'invalid' }
  }
  return { ok: true, e164: pn.number }
}

function digitsOnly(s: string): string {
  let out = ''
  for (const ch of s) if (ch >= '0' && ch <= '9') out += ch
  return out
}
