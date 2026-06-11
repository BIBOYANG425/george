// Geo tools: travel_time (Phase 1) + find_places_near (Phase 2, TODO).
// All tool outputs are JSON-stringified for the agent. Errors surface as
// { error: ... } objects, never thrown. resolveOrigin (alias table → fail-
// closed acronym check → geocoder) is exported for the Slice A spatial
// tools (distance_compare, safe_route, dps_zone_check).
//
// Header last reviewed: 2026-06-10

import { z } from 'zod'
import { resolveAlias } from '../services/usc-aliases.js'
import { geocode, distanceMatrix, GeoError } from '../services/google-maps.js'
import { checkGeoBudget } from '../services/geo-rate-limit.js'
import { wrapTool } from './_wrap.js'

type Mode = 'walking' | 'driving' | 'transit' | 'bicycling'
const ALLOWED_MODES: readonly Mode[] = ['walking', 'driving', 'transit', 'bicycling'] as const
function isValidMode(m: string): m is Mode {
  return (ALLOWED_MODES as readonly string[]).includes(m)
}

type LatLng = { lat: number; lng: number }
type GeoToolError =
  | { error: 'need_location'; hint: string }
  | { error: 'geo_unavailable' }
  | { error: 'geo_disabled' }
  | { error: 'geo_budget_exceeded' }

// USC-internal acronyms like "MRF", "KAP", "JFF" geocode to random LA
// storefronts that happen to share letters. Fail closed before calling
// the geocoder — unknown USC acronyms belong in the alias table, not
// Google's index.
const SHORT_ACRONYM_RX = /^[a-z]{2,5}$/i

export async function resolveOrigin(
  input: string,
): Promise<
  | LatLng
  | { error: 'need_location'; hint: string }
  | { error: 'geo_disabled' }
  | { error: 'geo_unavailable' }
> {
  const aliased = resolveAlias(input)
  if (aliased) return { lat: aliased.lat, lng: aliased.lng }

  const trimmed = input.trim()
  if (SHORT_ACRONYM_RX.test(trimmed)) {
    return {
      error: 'need_location',
      hint: `"${input}" looks like an unknown USC acronym, ask the student which building they mean`,
    }
  }

  try {
    const loc = await geocode(input)
    if (!loc) {
      return {
        error: 'need_location',
        hint: `could not place "${input}" on a map, ask the student to clarify`,
      }
    }
    return loc
  } catch (err) {
    if (err instanceof GeoError) return { error: err.code }
    return { error: 'geo_unavailable' }
  }
}

const inputSchema = {
  from: z.string().describe('Origin name or address'),
  to: z.string().describe('Destination name or address'),
  mode: z.string().optional().describe('Travel mode: walking (default) | driving | transit | bicycling'),
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function travelTimeHandler(input: {
  from: string
  to: string
  mode?: string
  student_id?: string
}): Promise<string> {
  const from = String(input.from ?? '')
  const to = String(input.to ?? '')
  const rawMode = String(input.mode ?? 'walking').toLowerCase()
  const mode: Mode = isValidMode(rawMode) ? rawMode : 'walking'
  const studentId = String(input.student_id ?? '')

  if (!checkGeoBudget(studentId)) {
    return JSON.stringify({ error: 'geo_budget_exceeded' } satisfies GeoToolError)
  }

  const fromLoc = await resolveOrigin(from)
  if ('error' in fromLoc) return JSON.stringify(fromLoc)
  const toLoc = await resolveOrigin(to)
  if ('error' in toLoc) return JSON.stringify(toLoc)

  try {
    const matrix = await distanceMatrix([fromLoc], [toLoc], mode)
    const el = matrix[0]?.[0]
    if (!el) {
      return JSON.stringify({
        error: 'need_location',
        hint: 'route could not be computed between those points',
      })
    }
    return JSON.stringify({
      minutes: el.minutes,
      km: el.km,
      walkable: mode === 'walking' && el.minutes <= 20,
      mode,
    })
  } catch (err) {
    if (err instanceof GeoError) {
      return JSON.stringify({ error: err.code } satisfies GeoToolError)
    }
    return JSON.stringify({ error: 'geo_unavailable' } satisfies GeoToolError)
  }
}

export const placesTool = wrapTool({
  name: 'travel_time',
  description: 'Compute travel time and distance between two locations. Use BEFORE claiming something is walkable from somewhere. Returns { minutes, km, walkable, mode } or an error object.',
  schema: inputSchema,
  handler: travelTimeHandler,
})
