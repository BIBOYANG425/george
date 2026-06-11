// src/tools/safe-route.ts
// safe_route: facts for "is X safe to walk to at <time>?". Returns DPS zone
// membership, share-Lyft-hours status, and a walking estimate. Deliberately
// returns FACTS, not a safe/unsafe verdict — the persona phrases the advice
// (per AGENT.md, the safety circle is "DPS-patrolled area 8pm-3am = free
// share Lyft zone"). Zone facts require data/dps-zones-v1.geojson; without
// it the tool still reports walk time + Lyft hours but marks zone data
// unavailable so george never invents zone membership.
//
// Header last reviewed: 2026-06-10

import { z } from 'zod'
import { wrapTool } from './_wrap.js'
import { resolveOrigin } from './places.js'
import { checkGeoBudget } from '../services/geo-rate-limit.js'
import {
  walkingMinutesEstimate,
  loadDpsZones,
  zoneForPoint,
  isLyftHoursActive,
  laHour,
  LYFT_START_HOUR,
  LYFT_END_HOUR,
} from '../services/spatial.js'

const inputSchema = {
  to: z.string().describe('Destination name, USC alias, or address'),
  from: z
    .string()
    .optional()
    .describe('Origin (defaults to UPC main campus if the student did not say)'),
  at_hour: z
    .number()
    .min(0)
    .max(23)
    .optional()
    .describe('LA-local hour 0-23 the student plans to walk (defaults to now)'),
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function safeRouteHandler(input: {
  to: string
  from?: string
  at_hour?: number
  student_id?: string
}): Promise<string> {
  const studentId = String(input.student_id ?? '')
  if (!checkGeoBudget(studentId)) {
    return JSON.stringify({ error: 'geo_budget_exceeded' })
  }

  const origin = await resolveOrigin(String(input.from ?? 'UPC'))
  if ('error' in origin) return JSON.stringify(origin)
  const dest = await resolveOrigin(String(input.to ?? ''))
  if ('error' in dest) return JSON.stringify(dest)

  const hour = input.at_hour ?? laHour(new Date())
  const lyftActive = hour >= LYFT_START_HOUR || hour < LYFT_END_HOUR

  const zones = await loadDpsZones()
  const zone = zones ? zoneForPoint(dest, zones) : null

  return JSON.stringify({
    walk_minutes_estimate: walkingMinutesEstimate(origin, dest),
    at_hour: hour,
    lyft_hours_active: lyftActive,
    lyft_hours: `${LYFT_START_HOUR}:00-0${LYFT_END_HOUR}:00 LA`,
    zone_data_available: zones !== null,
    in_dps_coverage: zones === null ? null : zone !== null,
    zone: zone ? { name: zone.name, risk: zone.risk } : null,
    note:
      zones === null
        ? 'zone map not loaded — do not claim zone membership; Lyft-hours + walk estimate are still reliable'
        : undefined,
  })
}

export const safeRouteTool = wrapTool({
  name: 'safe_route',
  description:
    'Facts for late-night walkability questions ("is X safe to walk to at 11pm?"). Returns walking estimate, whether DPS free share-Lyft hours (8pm-3am) apply at that hour, and DPS zone membership when zone data is loaded. Use BEFORE any safety claim about a route or place. Phrase the advice yourself; recommend the free DPS Lyft inside coverage during Lyft hours.',
  schema: inputSchema,
  handler: safeRouteHandler,
})
