// src/tools/distance-compare.ts
// distance_compare: rank candidate places by distance from one origin.
// Alias-table hits are pure local math (zero Google spend); unknown names
// fall back to the geocoder under the shared geo budget. Walking minutes are
// straight-line estimates — exact routed times stay travel_time's job.
//
// Header last reviewed: 2026-06-10

import { z } from 'zod'
import { wrapTool } from './_wrap.js'
import { resolveOrigin } from './places.js'
import { checkGeoBudget } from '../services/geo-rate-limit.js'
import { haversineKm, walkingMinutesEstimate } from '../services/spatial.js'

const inputSchema = {
  from: z.string().describe('Origin name, USC alias, or address'),
  candidates: z
    .array(z.string())
    .min(2)
    .max(8)
    .describe('2-8 place names to rank by distance from the origin'),
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function distanceCompareHandler(input: {
  from: string
  candidates: string[]
  student_id?: string
}): Promise<string> {
  const studentId = String(input.student_id ?? '')
  if (!checkGeoBudget(studentId)) {
    return JSON.stringify({ error: 'geo_budget_exceeded' })
  }

  const origin = await resolveOrigin(String(input.from ?? ''))
  if ('error' in origin) return JSON.stringify(origin)

  const ranked: Array<{ place: string; km: number; walk_minutes_estimate: number }> = []
  const unresolved: Array<{ place: string; hint: string }> = []

  for (const name of input.candidates) {
    const loc = await resolveOrigin(String(name))
    if ('error' in loc) {
      // A hard geo failure aborts the whole comparison; a merely-unknown name
      // is reported per-place so the rest of the ranking still lands.
      if (loc.error !== 'need_location') return JSON.stringify(loc)
      unresolved.push({ place: name, hint: loc.hint })
      continue
    }
    const km = haversineKm(origin, loc)
    ranked.push({
      place: name,
      km: Math.round(km * 100) / 100,
      walk_minutes_estimate: walkingMinutesEstimate(origin, loc),
    })
  }

  ranked.sort((a, b) => a.km - b.km)
  return JSON.stringify({
    from: input.from,
    ranked,
    unresolved: unresolved.length ? unresolved : undefined,
    note: 'distances are straight-line; use travel_time for an exact routed claim',
  })
}

export const distanceCompareTool = wrapTool({
  name: 'distance_compare',
  description:
    'Rank 2-8 places by distance from an origin ("which of these is closest to X?"). Returns { ranked: [{place, km, walk_minutes_estimate}], unresolved }. Estimates are straight-line — for an exact "N minutes walk" claim, follow up with travel_time.',
  schema: inputSchema,
  handler: distanceCompareHandler,
})
