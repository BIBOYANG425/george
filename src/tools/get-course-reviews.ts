import { z } from 'zod'
import { config } from '../config.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  dept: z.string().describe('Department code (e.g., CSCI)'),
  number: z.string().describe('Course number (e.g., 201)'),
  professor: z.string().optional().describe('Professor name filter'),
}

export async function getCourseReviewsHandler(input: {
  dept: string
  number: string
  professor?: string
}): Promise<string> {
  const params = new URLSearchParams({
    dept: input.dept.toUpperCase(),
    number: input.number,
  })
  if (input.professor) params.set('professor', input.professor)
  const res = await fetch(`${config.biaRoommate.baseUrl}/api/course-rating/reviews?${params}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return `Review lookup failed (${res.status})`
  const data = await res.json()
  if (!data.reviews || data.reviews.length === 0) return 'No reviews found.'

  // Collect distinct instructor names from reviews and/or sections.
  const names = new Set<string>()
  const collect = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) names.add(v.trim())
  }
  if (Array.isArray(data.reviews)) {
    for (const r of data.reviews) collect((r as { instructor?: unknown })?.instructor)
  }
  if (Array.isArray(data.sections)) {
    for (const s of data.sections) collect((s as { instructor?: unknown })?.instructor)
  }

  let rmp: Record<string, unknown> = {}
  const nameList = Array.from(names).slice(0, 50)
  if (nameList.length > 0) {
    try {
      // bia-roommate /api/rmp/batch is GET with ?names=a,b,c — not POST.
      const qs = new URLSearchParams({ names: nameList.join(',') })
      const rmpRes = await fetch(`${config.biaRoommate.baseUrl}/api/rmp/batch?${qs.toString()}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (rmpRes.ok) {
        rmp = await rmpRes.json()
      }
    } catch {
      // Swallow — RMP enrichment is best-effort; BIA reviews are the primary payload.
    }
  }

  // Surface a freshness signal so George can hedge confidently.
  let reviews_freshest_at: string | null = null
  if (Array.isArray(data.reviews)) {
    let newest = 0
    for (const r of data.reviews) {
      const ts = (r as { created_at?: unknown })?.created_at
      if (typeof ts === 'string') {
        const ms = Date.parse(ts)
        if (Number.isFinite(ms) && ms > newest) newest = ms
      }
    }
    if (newest > 0) reviews_freshest_at = new Date(newest).toISOString()
  }

  return JSON.stringify(
    { bia_reviews: data, rmp, reviews_freshest_at },
    null,
    2,
  )
}

export const getCourseReviewsTool = wrapTool({
  name: 'get_course_reviews',
  description: 'Get student reviews and ratings for a specific course, merged with live RMP ratings for each instructor. Returns { bia_reviews, rmp }.',
  schema: inputSchema,
  handler: getCourseReviewsHandler,
})
