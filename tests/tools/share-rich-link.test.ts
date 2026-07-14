// tests/tools/share-rich-link.test.ts
//
// The share_rich_link signal tool: validates its url input and returns a
// confirmation string (it does NOT send — runOrchestrator turns the tool call
// into a {type:'richlink'} event the Spectrum transport consumes). Plus the
// flag gate that registers it in lockstep.

import { describe, it, expect, afterEach } from 'vitest'
import { shareRichLinkHandler, isRichLinksEnabled } from '../../src/tools/share-rich-link.js'

describe('shareRichLinkHandler', () => {
  it('accepts a full https URL and confirms the card is queued', async () => {
    const out = await shareRichLinkHandler({ url: 'https://uscbia.com/events/city-walk' })
    expect(out).toContain('https://uscbia.com/events/city-walk')
    expect(out.toLowerCase()).toContain('card')
  })

  it('accepts http as well as https', async () => {
    expect(await shareRichLinkHandler({ url: 'http://example.com/x' })).toContain('http://example.com/x')
  })

  it('rejects a non-URL / empty / bare word', async () => {
    for (const url of ['', '   ', 'not a url', 'uscbia.com', 'ftp://x']) {
      expect(await shareRichLinkHandler({ url })).toContain('needs a full http(s)')
    }
  })

  it('trims surrounding whitespace before validating', async () => {
    expect(await shareRichLinkHandler({ url: '  https://a.co/b  ' })).toContain('https://a.co/b')
  })
})

describe('isRichLinksEnabled', () => {
  const prev = process.env.GEORGE_RICH_LINKS_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.GEORGE_RICH_LINKS_ENABLED
    else process.env.GEORGE_RICH_LINKS_ENABLED = prev
  })

  it('is OFF by default and ON only for the exact string "true"', () => {
    delete process.env.GEORGE_RICH_LINKS_ENABLED
    expect(isRichLinksEnabled()).toBe(false)
    process.env.GEORGE_RICH_LINKS_ENABLED = '1'
    expect(isRichLinksEnabled()).toBe(false)
    process.env.GEORGE_RICH_LINKS_ENABLED = 'true'
    expect(isRichLinksEnabled()).toBe(true)
  })
})
