import { describe, it, expect, beforeEach } from 'vitest'
import { trustedDomains } from '../../src/services/web-search-config.js'

beforeEach(() => { delete process.env.WEB_SEARCH_ALLOWED_DOMAINS })

describe('trustedDomains', () => {
  it('returns the curated default list', () => {
    expect(trustedDomains()).toContain('xiaohongshu.com')
    expect(trustedDomains()).toContain('usc.edu')
  })
  it('parses a comma-separated env override (trimmed)', () => {
    process.env.WEB_SEARCH_ALLOWED_DOMAINS = 'a.com, b.com ,c.com'
    expect(trustedDomains()).toEqual(['a.com', 'b.com', 'c.com'])
  })
  it('falls back to default on a blank override', () => {
    process.env.WEB_SEARCH_ALLOWED_DOMAINS = '   '
    expect(trustedDomains()).toContain('reddit.com')
  })
})
