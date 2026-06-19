import { describe, it, expect } from 'vitest'
import { normalizeHandle } from '../../src/services/phone-handle.js'

describe('normalizeHandle', () => {
  it('keeps a clean E.164 number unchanged', () => {
    expect(normalizeHandle('+15551234567')).toBe('+15551234567')
  })
  it('strips spaces, dashes, parens', () => {
    expect(normalizeHandle('+1 (555) 123-4567')).toBe('+15551234567')
  })
  it('adds +1 to a bare 10-digit US number', () => {
    expect(normalizeHandle('5551234567')).toBe('+15551234567')
  })
  it('adds + to an 11-digit number starting with 1', () => {
    expect(normalizeHandle('15551234567')).toBe('+15551234567')
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
