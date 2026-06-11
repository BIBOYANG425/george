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
  it('lowercases and trims an email handle, leaving it otherwise intact', () => {
    expect(normalizeHandle('  Alice@USC.edu ')).toBe('alice@usc.edu')
  })
  it('returns empty string for empty input', () => {
    expect(normalizeHandle('')).toBe('')
  })
})
