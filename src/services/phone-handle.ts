// src/services/phone-handle.ts
// Normalizes an iMessage sender handle so Spectrum's E.164 phone matches the
// format stored in students.imessage_id. Emails are lowercased/trimmed. Phones
// are reduced to E.164 (+<country><number>): any explicit country code (a
// leading "+" or the "00" international dialing prefix) is preserved as-is, so
// +86 (China), +44, +33, etc. survive intact. Bare North-American numbers (10
// digits, or 11 starting with 1) default to +1. Pure, no I/O.
//
// Known limit: a bare 11-digit number starting with 1 is ambiguous between a US
// "1 + area code" and a Chinese mobile (1[3-9]xxxxxxxxx) when no country code is
// present. We default to +1 because iMessage/Spectrum always delivers Chinese
// numbers as +86 E.164, so the country code is present on the real inbound path.
//
// Header last reviewed: 2026-06-18

export function normalizeHandle(raw: string): string {
  const s = (raw ?? '').trim()
  if (s === '') return ''
  if (s.includes('@')) return s.toLowerCase()

  // Keep only digits and a leading "+".
  let digits = s.replace(/[^\d+]/g, '')

  // "00" is the international dialing prefix, equivalent to a leading "+"
  // (e.g. 008613812345678 -> +8613812345678). Normalize it so the country code
  // is not mistaken for part of the subscriber number.
  if (!digits.startsWith('+') && digits.startsWith('00')) {
    digits = `+${digits.slice(2)}`
  }

  // Any explicit country code is trusted as-is. This is the common case: every
  // Spectrum/iMessage handle arrives as E.164, so +8613..., +15551234567,
  // +447911123456 all pass through unchanged.
  if (digits.startsWith('+')) return digits

  // Bare numbers with no country code. CN mobiles are 11 digits, so a 10-digit
  // bare number is unambiguously North American.
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`

  // Otherwise assume the leading digits already include a country code
  // (8613812345678 -> +8613812345678, 447911123456 -> +447911123456).
  return `+${digits}`
}
