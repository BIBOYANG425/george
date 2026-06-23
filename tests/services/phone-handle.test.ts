import { describe, it, expect } from 'vitest'
import { normalizeHandle } from '../../src/services/phone-handle.js'

describe('normalizeHandle', () => {
  it('keeps a clean E.164 number unchanged', () => {
    expect(normalizeHandle('+12135550142')).toBe('+12135550142')
  })
  it('strips spaces, dashes, parens', () => {
    expect(normalizeHandle('+1 (213) 555-0142')).toBe('+12135550142')
  })
  it('adds +1 to a bare 10-digit US number', () => {
    expect(normalizeHandle('2135550142')).toBe('+12135550142')
  })
  it('adds + to an 11-digit number starting with 1', () => {
    expect(normalizeHandle('12135550142')).toBe('+12135550142')
  })
  it('keeps a +86 China E.164 number unchanged', () => {
    expect(normalizeHandle('+8613812345678')).toBe('+8613812345678')
  })
  it('strips formatting from a +86 number', () => {
    expect(normalizeHandle('+86 138 1234 5678')).toBe('+8613812345678')
  })
  it('converts the 00 international prefix to + (China)', () => {
    expect(normalizeHandle('008613812345678')).toBe('+8613812345678')
  })
  it('converts the 00 international prefix to + (UK)', () => {
    expect(normalizeHandle('00447911123456')).toBe('+447911123456')
  })
  it('adds + to a bare 86-prefixed China mobile', () => {
    expect(normalizeHandle('8613812345678')).toBe('+8613812345678')
  })
  it('preserves other country codes (+44 UK, +33 FR)', () => {
    expect(normalizeHandle('+44 7911 123456')).toBe('+447911123456')
    expect(normalizeHandle('+33 6 12 34 56 78')).toBe('+33612345678')
  })
  it('lowercases and trims an email handle, leaving it otherwise intact', () => {
    expect(normalizeHandle('  Alice@USC.edu ')).toBe('alice@usc.edu')
  })
  it('returns empty string for empty input', () => {
    expect(normalizeHandle('')).toBe('')
  })
})

describe('normalizeHandle — delegates phone canonicalization to canonicalizePhone', () => {
  // The whole point of Phase 2: a phone handle gets canonicalized identically to
  // the bia-roommate signup side, so the +86/+853 fork can't happen on either path.
  it('canonicalizes a full +86 number that arrived without a leading + (the +86/+853 class)', () => {
    expect(normalizeHandle('8615522499291')).toBe('+8615522499291')
    expect(normalizeHandle('+8615522499291')).toBe('+8615522499291')
  })

  it('produces the SAME canonical E.164 whether the +86 number is typed with or without +', () => {
    expect(normalizeHandle('8615522499291')).toBe(normalizeHandle('+8615522499291'))
  })

  it('is idempotent on an already-canonical +1 number', () => {
    const once = normalizeHandle('+12135550142')
    expect(once).toBe('+12135550142')
    expect(normalizeHandle(once)).toBe('+12135550142')
  })
})

describe('normalizeHandle — non-phone handles pass through UNCHANGED', () => {
  it('passes web-anon through untouched', () => {
    expect(normalizeHandle('web-anon')).toBe('web-anon')
  })
  it('passes relay-smoke through untouched', () => {
    expect(normalizeHandle('relay-smoke')).toBe('relay-smoke')
  })
  it('passes a WeChat openid through untouched', () => {
    expect(normalizeHandle('wxid_0x1ugii4w92f22')).toBe('wxid_0x1ugii4w92f22')
    expect(normalizeHandle('oABCD1234efGHijkLMnopQRstuv')).toBe('oABCD1234efGHijkLMnopQRstuv')
  })
  it('passes an arbitrary non-numeric handle through untouched', () => {
    expect(normalizeHandle('dev')).toBe('dev')
  })
  it('passes a phone-shaped handle that is not a valid number through untouched (never drops it)', () => {
    // "12" is digit-shaped but not a real number → ok:false → unchanged.
    expect(normalizeHandle('12')).toBe('12')
  })
})
