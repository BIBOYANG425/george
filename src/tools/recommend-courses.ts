import { z } from 'zod'
import { config } from '../config.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  interests: z.string().describe('Student interests or topics'),
  semester: z.string().optional().describe('Semester code'),
  units: z.string().optional().describe('Unit count filter'),
  level: z.string().optional().describe('Course level: lower, upper, or graduate'),
}

export async function recommendCoursesHandler(input: {
  interests: string
  semester?: string
  units?: string
  level?: string
}): Promise<string> {
  // 'interest' (not 'free') so bia-roommate runs the LLM interest-recommender
  // agent — real interest-matched courses with reasoning (e.g. CSCI 360 for
  // "ai + film"). 'free' is dumb keyword matching that returns generic GE
  // courses, which made george hedge instead of naming relevant classes.
  const body: Record<string, string> = { interests: input.interests, mode: 'interest' }
  if (input.semester) body.semester = input.semester
  if (input.units) body.units = input.units
  if (input.level) body.level = input.level

  const res = await fetch(`${config.biaRoommate.baseUrl}/api/courses/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Interest mode runs an LLM recommender agent server-side, which is slower
    // than the old keyword path — give it real headroom (george shows a typing
    // bubble meanwhile).
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) return `Course recommendation failed (${res.status})`
  const data = await res.json()
  if (!data.recommendations || data.recommendations.length === 0) {
    return 'No recommendations found.'
  }
  return JSON.stringify(data, null, 2)
}

export const recommendCoursesTool = wrapTool({
  name: 'recommend_courses',
  description: 'Get personalized course recommendations based on interests.',
  schema: inputSchema,
  handler: recommendCoursesHandler,
})
