import { describe, it, expect } from 'vitest'
import { canonicalizePhone } from '../../src/services/phone-canonical.js'
import vector from '../../src/services/phone-canonical.vector.json' with { type: 'json' }

type VectorCase = {
  name: string
  input: string
  opts: { defaultCountry?: string; dialCode?: string } | null
  expected: { ok: true; e164: string } | { ok: false }
}

// THE cross-repo parity contract. bia-roommate copies phone-canonical.ts +
// phone-canonical.vector.json verbatim and runs this same assertion loop, so the
// two repos' phone normalization can never drift.
describe('canonicalizePhone — parity vector', () => {
  for (const c of vector as VectorCase[]) {
    it(c.name, () => {
      const result = canonicalizePhone(c.input, c.opts ?? undefined)
      if (c.expected.ok) {
        expect(result.ok).toBe(true)
        expect(result.e164).toBe(c.expected.e164)
      } else {
        expect(result.ok).toBe(false)
        // On failure e164 is always null.
        if (!result.ok) expect(result.e164).toBeNull()
      }
    })
  }
})

describe('canonicalizePhone — direct edge cases', () => {
  it('trims whitespace before canonicalizing', () => {
    expect(canonicalizePhone('  +12135550142  ')).toEqual({
      ok: true,
      e164: '+12135550142',
    })
  })

  it('reports reason "empty" for whitespace-only input', () => {
    const r = canonicalizePhone('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })

  it('reports reason "invalid" for junk', () => {
    const r = canonicalizePhone('not-a-phone')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid')
  })

  it('the +86/+853 fork: a full +86 number with a +853 dropdown trusts the typed number, never blindly concatenates the dial code', () => {
    const r = canonicalizePhone('8615522499291', { dialCode: '+853' })
    expect(r).toEqual({ ok: true, e164: '+8615522499291' })
    // The bug would have produced a +853-prefixed string; assert it did NOT.
    expect(r.ok && r.e164.startsWith('+853')).toBe(false)
  })

  it('is idempotent: feeding a canonical E.164 back in returns the same string', () => {
    const first = canonicalizePhone('(213) 555-0142', { dialCode: '+1' })
    expect(first.ok).toBe(true)
    if (first.ok) {
      const second = canonicalizePhone(first.e164)
      expect(second).toEqual({ ok: true, e164: first.e164 })
    }
  })

  it('strips an embedded (non-leading) "+" as junk', () => {
    // Only a leading "+" is honored; "1+2..." is not a valid number.
    const r = canonicalizePhone('21+35550142', { dialCode: '+1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.e164).toBe('+12135550142')
  })
})
