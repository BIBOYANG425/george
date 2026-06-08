// Batch-looks-up RMP (RateMyProfessors) ratings for USC instructors. Proxies to
// bia-roommate's /api/rmp/batch endpoint which handles the RMP GraphQL + in-memory
// caching. Returns {name → {avgRating, avgDifficulty, numRatings, wouldTakeAgainPercent}}.
//
// Header last reviewed: 2026-06-07

import { z } from 'zod'
import { config } from '../config.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  names: z.array(z.string()).describe('List of instructor full names (first + last). Max 50.'),
}

export async function getRmpRatingsHandler(input: { names: string[] }): Promise<string> {
  const names = Array.isArray(input.names) ? input.names.filter((n) => n && n.trim()) : []
  if (names.length === 0) return 'Error: names must be a non-empty array of instructor names.'
  if (names.length > 50) return 'Error: at most 50 names per call.'

  // bia-roommate's /api/rmp/batch is GET with comma-separated ?names= query param,
  // not a POST body. Response shape: { ratings: { <name>: {...} | null } }.
  const qs = new URLSearchParams({ names: names.join(',') })
  const res = await fetch(`${config.biaRoommate.baseUrl}/api/rmp/batch?${qs.toString()}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return `RMP batch lookup failed (${res.status})`
  const data = await res.json()
  return JSON.stringify(data)
}

export const getRmpRatingsTool = wrapTool({
  name: 'get_rmp_ratings',
  description: 'Look up RateMyProfessors ratings for USC instructors in batch. Returns per-name rating (avg, difficulty, count, would-take-again%) or null for professors with no RMP record.',
  schema: inputSchema,
  handler: getRmpRatingsHandler,
})
