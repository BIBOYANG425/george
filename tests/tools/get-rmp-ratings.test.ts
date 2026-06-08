import { describe, it, expect, vi, afterEach } from 'vitest'

// Stub required env vars BEFORE config.ts loads
process.env.ANTHROPIC_API_KEY ||= 'test-key'
process.env.SUPABASE_URL ||= 'http://localhost'
process.env.SUPABASE_ANON_KEY ||= 'test-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key'

const fetchMock = vi.fn()
// @ts-expect-error override global fetch
globalThis.fetch = fetchMock

describe('get_rmp_ratings tool', () => {
  afterEach(() => {
    fetchMock.mockReset()
  })

  it('tool name is get_rmp_ratings', async () => {
    const { getRmpRatingsTool } = await import('../../src/tools/get-rmp-ratings.js')
    expect(getRmpRatingsTool.name).toBe('get_rmp_ratings')
  })

  it('returns error for empty names', async () => {
    const { getRmpRatingsHandler } = await import('../../src/tools/get-rmp-ratings.js')
    const result = await getRmpRatingsHandler({ names: [] })
    expect(result.toLowerCase()).toContain('names')
  })

  it('returns error for >50 names', async () => {
    const names = Array.from({ length: 51 }, (_, i) => `Prof ${i}`)
    const { getRmpRatingsHandler } = await import('../../src/tools/get-rmp-ratings.js')
    const result = await getRmpRatingsHandler({ names })
    expect(result.toLowerCase()).toContain('at most 50')
  })

  it('returns batch response on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ratings: { 'Jane Doe': { avgRating: 4.7, avgDifficulty: 3.1, numRatings: 22, wouldTakeAgainPercent: 93 } } }),
    })
    const { getRmpRatingsHandler } = await import('../../src/tools/get-rmp-ratings.js')
    const result = await getRmpRatingsHandler({ names: ['Jane Doe'] })
    expect(result).toContain('Jane Doe')
    expect(result).toContain('4.7')
  })

  it('calls /api/rmp/batch as GET with comma-separated names query string', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ratings: {} }) })
    const { getRmpRatingsHandler } = await import('../../src/tools/get-rmp-ratings.js')
    await getRmpRatingsHandler({ names: ['Jane Doe', 'John Smith'] })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toContain('/api/rmp/batch?')
    // GET: no method set is also acceptable
    expect(init?.method).toBeUndefined()
    // Names encoded as comma-separated in query
    expect(url).toContain('names=Jane+Doe%2CJohn+Smith')
  })

  it('returns lookup-failed on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    const { getRmpRatingsHandler } = await import('../../src/tools/get-rmp-ratings.js')
    const result = await getRmpRatingsHandler({ names: ['Jane Doe'] })
    expect(result.toLowerCase()).toContain('failed')
    expect(result).toContain('500')
  })
})
