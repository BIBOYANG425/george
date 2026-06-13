import { describe, it, expect, beforeEach } from 'vitest'
import { isWebSearchOverCap, recordWebSearchUse, _resetWebSearchBudget } from '../../src/services/web-search-budget.js'

beforeEach(() => { _resetWebSearchBudget(); delete process.env.WEB_SEARCH_DAILY_CAP })

describe('web search budget', () => {
  it('allows up to the cap, then reports over', () => {
    process.env.WEB_SEARCH_DAILY_CAP = '3'
    expect(isWebSearchOverCap('s1')).toBe(false)
    recordWebSearchUse('s1', 2)
    expect(isWebSearchOverCap('s1')).toBe(false)
    recordWebSearchUse('s1', 1)
    expect(isWebSearchOverCap('s1')).toBe(true)
  })
  it('defaults to 15/day', () => {
    recordWebSearchUse('s2', 14)
    expect(isWebSearchOverCap('s2')).toBe(false)
    recordWebSearchUse('s2', 1)
    expect(isWebSearchOverCap('s2')).toBe(true)
  })
  it('rolls over after 24h', () => {
    process.env.WEB_SEARCH_DAILY_CAP = '1'
    const t0 = 1_000_000
    recordWebSearchUse('s3', 1, t0)
    expect(isWebSearchOverCap('s3', t0)).toBe(true)
    expect(isWebSearchOverCap('s3', t0 + 25 * 60 * 60 * 1000)).toBe(false)
  })
  it('ignores non-positive counts', () => {
    recordWebSearchUse('s4', 0)
    expect(isWebSearchOverCap('s4')).toBe(false)
  })
})
