// src/tools/ge-candidates.ts
// Fast "ready sheet" for GE course recs. Reads the pre-built snapshot
// (src/services/ge-candidates.ts) in ONE local read — no live USC/RMP calls, no
// server-side recommender. George then personalizes the picks from the student
// profile. This is the speed lever for "recommend an easy/good GE class".

import { z } from 'zod'
import { wrapTool } from './_wrap.js'
import { readGeCandidates } from '../services/ge-candidates.js'

export const geCandidatesTool = wrapTool({
  name: 'ge_candidates',
  description:
    'FAST pre-built, rating-ranked list of GE courses, each with its best professor\'s RateMyProfessors rating, difficulty, would-take-again %, and open status. Use THIS in ONE call for "recommend an easy/good GE class" — do NOT chain search_ge_courses + get_rmp_ratings or call recommend_courses for GE recs (those are slow). Optionally filter by category (GE-A..GE-H, GESM). After calling it, pick and order the results FOR THIS STUDENT using their profile (major, year, interests).',
  schema: {
    category: z.string().optional().describe('Optional GE category filter: GE-A..GE-H or GESM. Omit to span all cached categories.'),
    limit: z.number().optional().describe('Max candidates to return (default 25).'),
  },
  handler: async (input: { category?: string; limit?: number }) => {
    const { builtAt, courses } = readGeCandidates(input)
    if (courses.length === 0) {
      return 'GE candidate cache is empty (run scripts/build-ge-candidates). Fall back to search_ge_courses + get_rmp_ratings.'
    }
    return JSON.stringify({ builtAt, count: courses.length, courses })
  },
})
