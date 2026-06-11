// src/services/phone-handle.ts
// Normalizes an iMessage sender handle so Spectrum's E.164 phone matches the
// format stored in students.imessage_id. Emails are lowercased/trimmed; phones
// are reduced to E.164 (+<country><number>). Pure, no I/O.
//
// Header last reviewed: 2026-06-11

export function normalizeHandle(raw: string): string {
  const s = (raw ?? '').trim()
  if (s === '') return ''
  if (s.includes('@')) return s.toLowerCase()

  const digits = s.replace(/[^\d+]/g, '')
  const bare = digits.replace(/^\+/, '')
  if (bare.length === 10) return `+1${bare}`
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`
  return digits.startsWith('+') ? digits : `+${bare}`
}
