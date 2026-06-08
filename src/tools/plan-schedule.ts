import { z } from 'zod'
import { config } from '../config.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  courses: z.string().describe('Comma-separated DEPT-NUMBER (e.g., "CSCI-201,MATH-225")'),
  semester: z.string().optional().describe('Semester code'),
}

export async function planScheduleHandler(input: {
  courses: string
  semester?: string
}): Promise<string> {
  const params = new URLSearchParams({ courses: input.courses })
  if (input.semester) params.set('semester', input.semester)
  const courseRes = await fetch(`${config.biaRoommate.baseUrl}/api/courses/coursebin?${params}`, { signal: AbortSignal.timeout(10_000) })
  if (!courseRes.ok) return `Schedule lookup failed (${courseRes.status})`
  const courseData = await courseRes.json()
  const ratingRes = await fetch(`${config.biaRoommate.baseUrl}/api/course-rating/aggregates?${params}`, { signal: AbortSignal.timeout(10_000) })
  const ratingData = ratingRes.ok ? await ratingRes.json() : { aggregates: {} }
  return JSON.stringify({ courses: courseData.courses, ratings: ratingData.aggregates }, null, 2)
}

export const planScheduleTool = wrapTool({
  name: 'plan_schedule',
  description: 'Get detailed course info for schedule planning. Checks multiple courses at once.',
  schema: inputSchema,
  handler: planScheduleHandler,
})
