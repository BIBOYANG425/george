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
  const body: Record<string, string> = { interests: input.interests, mode: 'free' }
  if (input.semester) body.semester = input.semester
  if (input.units) body.units = input.units
  if (input.level) body.level = input.level

  const res = await fetch(`${config.biaRoommate.baseUrl}/api/courses/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
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
