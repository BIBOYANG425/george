import { describe, it, expect, afterEach, vi } from 'vitest'

// Stub required env vars BEFORE config.ts loads — get-course-reviews.ts
// imports config which throws on missing keys.
process.env.ANTHROPIC_API_KEY ||= 'test-key'
process.env.SUPABASE_URL ||= 'http://localhost'
process.env.SUPABASE_ANON_KEY ||= 'test-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key'

const fetchMock = vi.fn()
// @ts-expect-error override the global for hermetic tests
globalThis.fetch = fetchMock

describe('get_course_reviews tool (BIA + RMP merge)', () => {
  afterEach(() => {
    fetchMock.mockReset()
  })

  it('tool name is get_course_reviews and description mentions RMP', async () => {
    const { getCourseReviewsTool } = await import('../../src/tools/get-course-reviews.js')
    expect(getCourseReviewsTool.name).toBe('get_course_reviews')
    expect(getCourseReviewsTool.description.toLowerCase()).toContain('rmp')
  })

  it('merges bia_reviews + rmp payloads on success', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/api/course-rating/reviews')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            reviews: [
              { instructor: 'Jane Doe', rating: 5 },
              { instructor: 'John Smith', rating: 4 },
              { instructor: 'Jane Doe', rating: 3 }, // duplicate
            ],
          }),
        }
      }
      if (u.includes('/api/rmp/batch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            'Jane Doe': { avgRating: 4.5 },
            'John Smith': { avgRating: 3.8 },
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const { getCourseReviewsHandler } = await import('../../src/tools/get-course-reviews.js')
    const result = await getCourseReviewsHandler({ dept: 'csci', number: '201' })
    const parsed = JSON.parse(result)
    expect(parsed).toHaveProperty('bia_reviews')
    expect(parsed).toHaveProperty('rmp')
    expect(parsed.rmp['Jane Doe'].avgRating).toBe(4.5)
    expect(parsed.rmp['John Smith'].avgRating).toBe(3.8)

    // Verify the RMP call was made as GET with deduplicated names in the query string.
    const rmpCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/rmp/batch'))
    expect(rmpCall).toBeDefined()
    const rmpUrl = String(rmpCall![0])
    // GET — no body, name list encoded as comma-separated query param.
    expect((rmpCall![1] as RequestInit | undefined)?.method).toBeUndefined()
    expect(rmpUrl).toMatch(/names=[^&]*Jane\+Doe[^&]*John\+Smith|names=[^&]*John\+Smith[^&]*Jane\+Doe/)
  })

  it('skips RMP call when no instructors are present', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/api/course-rating/reviews')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ reviews: [{ rating: 4 /* no instructor field */ }] }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const { getCourseReviewsHandler } = await import('../../src/tools/get-course-reviews.js')
    const result = await getCourseReviewsHandler({ dept: 'csci', number: '201' })
    const parsed = JSON.parse(result)
    expect(parsed.rmp).toEqual({})
    const rmpCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/rmp/batch'))
    expect(rmpCall).toBeUndefined()
  })

  it('returns no-reviews when reviews array is empty', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ reviews: [] }),
    })
    const { getCourseReviewsHandler } = await import('../../src/tools/get-course-reviews.js')
    const result = await getCourseReviewsHandler({ dept: 'WRIT', number: '150' })
    expect(result.toLowerCase()).toContain('no reviews')
  })

  it('returns failure on non-ok reviews fetch', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const { getCourseReviewsHandler } = await import('../../src/tools/get-course-reviews.js')
    const result = await getCourseReviewsHandler({ dept: 'CSCI', number: '201' })
    expect(result).toContain('503')
  })

  it('includes reviews_freshest_at when created_at is present', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/api/course-rating/reviews')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            reviews: [
              { instructor: 'Prof A', rating: 5, created_at: '2025-01-15T00:00:00Z' },
              { instructor: 'Prof A', rating: 4, created_at: '2025-03-01T00:00:00Z' },
            ],
          }),
        }
      }
      if (u.includes('/api/rmp/batch')) {
        return { ok: true, status: 200, json: async () => ({}) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const { getCourseReviewsHandler } = await import('../../src/tools/get-course-reviews.js')
    const result = await getCourseReviewsHandler({ dept: 'CSCI', number: '499' })
    const parsed = JSON.parse(result)
    expect(parsed.reviews_freshest_at).toBe('2025-03-01T00:00:00.000Z')
  })
})
