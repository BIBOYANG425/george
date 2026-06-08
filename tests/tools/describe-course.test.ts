import { describe, it, expect, vi } from 'vitest'

const mockMaybeSingle = vi.fn()
vi.mock('../../src/db/client.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({ maybeSingle: mockMaybeSingle }),
          }),
        }),
      }),
    }),
  },
}))

describe('describe_course tool', () => {
  it('tool name is describe_course', async () => {
    const { describeCourseTool } = await import('../../src/tools/describe-course.js')
    expect(describeCourseTool.name).toBe('describe_course')
  })

  it('returns a not-found message on miss', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    const { describeCourseHandler } = await import('../../src/tools/describe-course.js')
    const result = await describeCourseHandler({ dept: 'ZZZ', code: '999' })
    expect(result.toLowerCase()).toContain('not found')
  })

  it('returns lookup-failed on Supabase error', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'relation does not exist' } })
    const { describeCourseHandler } = await import('../../src/tools/describe-course.js')
    const result = await describeCourseHandler({ dept: 'CSCI', code: '201L' })
    expect(result.toLowerCase()).toContain('lookup failed')
    expect(result).toContain('relation does not exist')
  })

  it('returns stringified row on hit', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        dept: 'CSCI',
        code: '201L',
        title: 'Principles of Software Development',
        description: 'desc',
        units: '4',
        terms: 'FaSp',
        prereq: 'CSCI 104',
        corequisite: null,
        recommended_prep: null,
        restriction: null,
        mode: 'Lecture',
        grading: 'Letter',
        source_url: 'https://...',
      },
      error: null,
    })
    const { describeCourseHandler } = await import('../../src/tools/describe-course.js')
    const result = await describeCourseHandler({ dept: 'CSCI', code: '201L' })
    expect(result).toContain('Principles of Software Development')
    expect(result).toContain('CSCI 104')
  })
})
