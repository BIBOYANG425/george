import { z } from 'zod'
import { getStudentById } from '../db/students.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function lookupStudentHandler(input: { student_id?: string }): Promise<string> {
  const studentId = input.student_id
  if (!studentId) return 'No student context available.'

  const student = await getStudentById(studentId)
  if (!student) return 'Student not found.'
  const {
    wechat_open_id: _wechat_open_id,
    imessage_id: _imessage_id,
    link_code: _link_code,
    link_code_expires_at: _link_code_expires_at,
    ...safe
  } = student
  return JSON.stringify(safe, null, 2)
}

export const lookupStudentTool = wrapTool({
  name: 'lookup_student',
  description: "Look up the current student's profile and preferences.",
  schema: inputSchema,
  handler: lookupStudentHandler,
})
