import { describe, it, expect, vi, afterEach } from 'vitest'

// Stub required env vars BEFORE config.ts loads
process.env.ANTHROPIC_API_KEY ||= 'test-key'
process.env.SUPABASE_URL ||= 'http://localhost'
process.env.SUPABASE_ANON_KEY ||= 'test-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key'

const fetchMock = vi.fn()
// @ts-expect-error override
globalThis.fetch = fetchMock

describe('recommend_courses tool', () => {
  afterEach(() => fetchMock.mockReset())

  it("POSTs with mode='free' to avoid LLM agent timeout", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ recommendations: [{ dept: 'CSCI', code: '201L' }] }),
    })
    const { recommendCoursesHandler } = await import('../../src/tools/recommend-courses.js')
    await recommendCoursesHandler({ interests: 'AI, startups' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0]
    const url = call[0] as string
    const init = call[1] as RequestInit
    expect(url).toContain('/api/courses/recommend')
    const body = JSON.parse(init.body as string)
    expect(body.mode).toBe('free')
    expect(body.interests).toBe('AI, startups')
  })

  it('returns empty-recs message when backend returns no recommendations', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ recommendations: [] }),
    })
    const { recommendCoursesHandler } = await import('../../src/tools/recommend-courses.js')
    const result = await recommendCoursesHandler({ interests: 'abstract algebra' })
    expect(result.toLowerCase()).toContain('no recommendations')
  })

  it('returns failure message on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    const { recommendCoursesHandler } = await import('../../src/tools/recommend-courses.js')
    const result = await recommendCoursesHandler({ interests: 'chess' })
    expect(result).toContain('503')
  })
})
