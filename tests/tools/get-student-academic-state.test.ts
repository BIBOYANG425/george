/**
 * Locks down get_student_academic_state — the tool the course voice MUST
 * call before recommending. It reads `students` (year/major/interests) +
 * `user_profiles` (academic/identity prose blocks); student_memories was
 * removed in the memory-consolidation refactor. Drift in the `missing` flag
 * logic would silently break the "ask before recommend" discipline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface StudentRow {
  year: string | null
  major: string | null
  interests: string[] | null
  user_id: string | null
}

interface ProfileRow {
  academic: string | null
  identity: string | null
}

let studentRow: StudentRow | null = null
let profileRow: ProfileRow | null = null
const tablesQueried: string[] = []

vi.mock('../../src/db/client.js', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      tablesQueried.push(table)
      if (table === 'students') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: studentRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'user_profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: profileRow, error: null }),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  },
}))

async function callHandler(input: { student_id?: string }) {
  const { getStudentAcademicStateHandler } = await import('../../src/tools/get-student-academic-state.js')
  const result = await getStudentAcademicStateHandler(input)
  return JSON.parse(result)
}

describe('get_student_academic_state', () => {
  beforeEach(() => {
    vi.resetModules()
    studentRow = null
    profileRow = null
    tablesQueried.length = 0
  })

  it('tool name is get_student_academic_state', async () => {
    const { getStudentAcademicStateTool } = await import('../../src/tools/get-student-academic-state.js')
    expect(getStudentAcademicStateTool.name).toBe('get_student_academic_state')
  })

  it('returns an error result when no student_id is provided', async () => {
    const out = await callHandler({})
    expect(out.error).toMatch(/no student context/i)
  })

  it('reads only students + user_profiles (never student_memories)', async () => {
    studentRow = { year: 'junior', major: 'CS', interests: ['AI'], user_id: 'u1' }
    profileRow = { academic: 'took CSCI 104', identity: 'name: Alice' }
    await callHandler({ student_id: 'stu-1' })
    expect(tablesQueried).toContain('students')
    expect(tablesQueried).toContain('user_profiles')
    expect(tablesQueried).not.toContain('student_memories')
  })

  it('flags year/major/academic_notes as missing for empty profile', async () => {
    studentRow = { year: null, major: null, interests: null, user_id: 'u-empty' }
    profileRow = { academic: '', identity: '' }
    const out = await callHandler({ student_id: 'stu-empty' })
    expect(out.profile).toEqual({ year: null, major: null, interests: [] })
    expect(out.academic_notes).toBeNull()
    expect(out.identity_notes).toBeNull()
    expect(out.missing).toEqual(
      expect.arrayContaining(['year', 'major', 'academic_notes']),
    )
  })

  it('has empty missing[] when year, major, and academic notes are present', async () => {
    studentRow = { year: 'junior', major: 'CS', interests: ['AI'], user_id: 'u-full' }
    profileRow = { academic: 'GE-A done; wants 14 units; prof bar 4.0', identity: 'name: Bob' }
    const out = await callHandler({ student_id: 'stu-full' })
    expect(out.missing).toEqual([])
    expect(out.profile.year).toBe('junior')
    expect(out.profile.major).toBe('CS')
    expect(out.academic_notes).toBe('GE-A done; wants 14 units; prof bar 4.0')
    expect(out.identity_notes).toBe('name: Bob')
  })

  it('surfaces year/major/interests from the students row', async () => {
    studentRow = { year: 'soph', major: 'EE', interests: ['robotics', 'music'], user_id: 'u-2' }
    profileRow = { academic: 'completed CSCI 104, MATH 225', identity: null }
    const out = await callHandler({ student_id: 'stu-rich' })
    expect(out.profile.year).toBe('soph')
    expect(out.profile.major).toBe('EE')
    expect(out.profile.interests).toEqual(['robotics', 'music'])
    expect(out.academic_notes).toContain('CSCI 104')
  })

  it('handles a student with no linked user_id (no profile lookup, notes null)', async () => {
    studentRow = { year: 'freshman', major: 'CS', interests: [], user_id: null }
    const out = await callHandler({ student_id: 'stu-no-uid' })
    expect(out.academic_notes).toBeNull()
    expect(out.identity_notes).toBeNull()
    expect(tablesQueried).not.toContain('user_profiles')
    expect(out.missing).toContain('academic_notes')
  })
})
