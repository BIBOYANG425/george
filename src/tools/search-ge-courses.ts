// src/tools/search-ge-courses.ts
// Lists REAL GE courses for a USC GE category from the live schedule of classes
// (via bia-roommate's /api/courses/ge → classes.usc.edu), each with its taught
// sections: instructor + topic + open/closed. This is what lets george answer
// "easy A GE-B" / GESM-topic questions with actual course numbers AND profs
// (then cross-ref get_rmp_ratings) instead of only seeing category "shells".
// For GESM it returns the per-topic seminar sections with their instructors.
//
// Header last reviewed: 2026-06-12

import { z } from 'zod'
import { config } from '../config.js'
import { wrapTool } from './_wrap.js'

const GE_CATEGORIES = [
  'GE-A', 'GE-B', 'GE-C', 'GE-D', 'GE-E', 'GE-F', 'GE-G', 'GE-H', 'GESM',
] as const

interface GeSection {
  type?: string
  topic?: string
  isClosed?: boolean
  instructor?: { firstName?: string; lastName?: string }
}
interface GeCourse {
  department: string
  number: string
  title: string
  units?: string
  sections?: GeSection[]
}

// Tolerate "B", "geb", "ge-b" → "GE-B"; "gesm" → "GESM".
function normalizeCategory(raw: string): string {
  const u = (raw ?? '').trim().toUpperCase()
  if (u === 'GESM') return 'GESM'
  const m = u.match(/^(?:GE-?)?([A-H])$/)
  return m ? `GE-${m[1]}` : u
}

const inputSchema = {
  category: z
    .string()
    .describe('GE category: GE-A, GE-B, GE-C, GE-D, GE-E, GE-F, GE-G, GE-H, or GESM'),
  semester: z.string().optional().describe('Semester code, e.g. 20263 (defaults to the next term)'),
}

export async function searchGeCoursesHandler(input: {
  category: string
  semester?: string
}): Promise<string> {
  const category = normalizeCategory(input.category)
  if (!(GE_CATEGORIES as readonly string[]).includes(category)) {
    return `Invalid GE category "${input.category}". Use one of: ${GE_CATEGORIES.join(', ')}.`
  }

  const params = new URLSearchParams({ category })
  if (input.semester) params.set('semester', input.semester)
  const res = await fetch(`${config.biaRoommate.baseUrl}/api/courses/ge?${params}`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return `GE course search failed (${res.status})`
  const data = (await res.json()) as GeCourse[]
  if (!Array.isArray(data) || data.length === 0) return `No ${category} courses found for that term.`

  // Compact each course to its taught sections (named instructor + topic +
  // open/closed) so the model can name real courses/profs and cross-ref RMP.
  // Sections without an instructor (discussions/labs/TBA) are dropped.
  const compact = data.map((c) => ({
    department: c.department,
    number: c.number,
    title: c.title,
    units: c.units,
    sections: (c.sections ?? [])
      .filter((s) => s.instructor && (s.instructor.firstName || s.instructor.lastName))
      .slice(0, 8)
      .map((s) => ({
        prof: `${s.instructor?.firstName ?? ''} ${s.instructor?.lastName ?? ''}`.trim(),
        topic: s.topic || undefined,
        open: !s.isClosed,
      })),
  }))
  return JSON.stringify(compact, null, 2)
}

export const searchGeCoursesTool = wrapTool({
  name: 'search_ge_courses',
  description:
    'List REAL GE courses for a USC GE category (GE-A..GE-H, or GESM) with each course\'s live sections — instructor name + topic + open/closed — from the schedule of classes. Use for "easy A GE-X" / GE-requirement / GESM-topic questions to get actual course numbers AND profs (then cross-ref get_rmp_ratings). For GESM, returns the per-topic seminar sections with their instructors.',
  schema: inputSchema,
  handler: searchGeCoursesHandler,
})
