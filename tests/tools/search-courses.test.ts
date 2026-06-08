import { describe, it, expect, vi, afterEach } from 'vitest'

// Stub required env vars BEFORE config.ts loads
process.env.ANTHROPIC_API_KEY ||= 'test-key'
process.env.SUPABASE_URL ||= 'http://localhost'
process.env.SUPABASE_ANON_KEY ||= 'test-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key'

const fetchMock = vi.fn()
// @ts-expect-error override
globalThis.fetch = fetchMock

const mockIn = vi.fn()
vi.mock('../../src/db/client.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: () => ({
        in: mockIn,
      }),
    })),
  },
}))

describe('search_courses tool (enriched)', () => {
  afterEach(() => {
    fetchMock.mockReset()
    mockIn.mockReset()
  })

  it('tool name is search_courses and description mentions catalog/description/prereq', async () => {
    const { searchCoursesTool } = await import('../../src/tools/search-courses.js')
    expect(searchCoursesTool.name).toBe('search_courses')
    expect(searchCoursesTool.description.toLowerCase()).toMatch(/catalog|description|prereq/)
  })

  it('attaches catalog data to section matches (prefix fallback: 201 -> 201L)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { department: 'CSCI', number: '201', title: 'Principles of Software Development', units: '4' },
      ],
    })
    mockIn.mockResolvedValueOnce({
      data: [
        {
          dept: 'CSCI',
          code: '201L',
          description: 'OOP in Java',
          prereq: 'CSCI 104',
          units: '4',
          terms: 'FaSp',
        },
      ],
      error: null,
    })
    const { searchCoursesHandler } = await import('../../src/tools/search-courses.js')
    const result = await searchCoursesHandler({ query: 'CSCI 201' })
    const parsed = JSON.parse(result)
    expect(parsed[0]).toHaveProperty('catalog')
    expect(parsed[0].catalog.description).toContain('OOP')
    expect(parsed[0].catalog.prereq).toBe('CSCI 104')
  })

  it('attaches catalog data on exact code match', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { department: 'WRIT', number: '150', title: 'Writing', units: '4' },
      ],
    })
    mockIn.mockResolvedValueOnce({
      data: [
        {
          dept: 'WRIT',
          code: '150',
          description: 'Freshman writing',
          prereq: null,
          units: '4',
          terms: 'FaSp',
        },
      ],
      error: null,
    })
    const { searchCoursesHandler } = await import('../../src/tools/search-courses.js')
    const result = await searchCoursesHandler({ query: 'WRIT 150' })
    const parsed = JSON.parse(result)
    expect(parsed[0].catalog.description).toBe('Freshman writing')
  })

  it('leaves catalog null when no match', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ department: 'ZZZ', number: '999', title: 'Unknown', units: '0' }],
    })
    mockIn.mockResolvedValueOnce({ data: [], error: null })
    const { searchCoursesHandler } = await import('../../src/tools/search-courses.js')
    const result = await searchCoursesHandler({ query: 'ZZZ 999' })
    const parsed = JSON.parse(result)
    expect(parsed[0].catalog).toBeNull()
  })

  it('returns no-courses message when WebReg returns empty', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] })
    const { searchCoursesHandler } = await import('../../src/tools/search-courses.js')
    const result = await searchCoursesHandler({ query: 'nothinghere' })
    expect(result.toLowerCase()).toContain('no courses')
  })

  it('returns failure message on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const { searchCoursesHandler } = await import('../../src/tools/search-courses.js')
    const result = await searchCoursesHandler({ query: 'x' })
    expect(result).toContain('Course search failed')
    expect(result).toContain('503')
  })
})
