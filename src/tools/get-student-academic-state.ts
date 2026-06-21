// Aggregates everything the course sub-agent needs to know about a student
// *before* recommending classes: year/major/interests from the students table,
// plus the student's free-form academic + identity memory blocks from
// user_profiles. This is the first tool the course voice should call for "what
// should I take" — it prevents re-asking facts george already has.
//
// The old structured completed-course / GE / preference store was removed in the
// memory-consolidation refactor; that data now lives as prose in the
// user_profiles academic block, so course preferences ride along in
// `academic_notes` rather than as discrete typed fields.
//
// Header last reviewed: 2026-06-21

import { z } from 'zod'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

interface AcademicState {
  profile: {
    year: string | null
    major: string | null
    interests: string[]
  }
  // Free-form academic context george has accumulated (completed courses, GE
  // progress, units/prof/time preferences if mentioned). Prose, not typed.
  academic_notes: string | null
  identity_notes: string | null
  missing: string[]
}

const inputSchema = {
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function getStudentAcademicStateHandler(input: {
  student_id?: string
}): Promise<string> {
  const studentId = input.student_id
  if (!studentId) {
    return JSON.stringify({
      error: 'No student context available — recommend asking the student directly.',
    })
  }

  const { data: student } = await supabase
    .from('students')
    .select('year, major, interests, user_id')
    .eq('id', studentId)
    .single()

  // The student's profile is keyed by user_id (the uuid user_profiles uses),
  // not the students.id, so resolve it via the students row's user_id.
  let academicNotes: string | null = null
  let identityNotes: string | null = null
  if (student?.user_id) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('academic, identity')
      .eq('user_id', student.user_id)
      .maybeSingle()
    academicNotes = profile?.academic?.trim() || null
    identityNotes = profile?.identity?.trim() || null
  }

  const state: AcademicState = {
    profile: {
      year: student?.year ?? null,
      major: student?.major ?? null,
      interests: Array.isArray(student?.interests) ? student.interests : [],
    },
    academic_notes: academicNotes,
    identity_notes: identityNotes,
    missing: [],
  }

  // Flag what's still unknown so the agent knows what to ask.
  if (!state.profile.year) state.missing.push('year')
  if (!state.profile.major) state.missing.push('major')
  if (!state.academic_notes) state.missing.push('academic_notes')

  return JSON.stringify(state, null, 2)
}

export const getStudentAcademicStateTool = wrapTool({
  name: 'get_student_academic_state',
  description: "Load the student's known academic state — year, major, courses completed, GE progress, and stored preferences. Call this FIRST when answering 'what should I take'.",
  schema: inputSchema,
  handler: getStudentAcademicStateHandler,
})
