// src/tools/find-places.ts
// find_places: real-world place/food/spot search via Google Places text search.
// Output is JSON-stringified; errors surface as { error } objects, never thrown
// (matches the other geo tools). Reuses the geo budget (cheap Maps call) and
// resolveOrigin to anchor the search area, defaulting to USC campus.
//
// Header last reviewed: 2026-06-13
import { z } from 'zod'
import { placesTextSearch, GeoError } from '../services/google-maps.js'
import { checkGeoBudget } from '../services/geo-rate-limit.js'
import { resolveOrigin } from './places.js'
import { wrapTool } from './_wrap.js'

// USC University Park campus center — default anchor when no area is named.
const USC_CENTER = { lat: 34.0224, lng: -118.2851 }

type FindPlacesError =
  | { error: 'geo_budget_exceeded' }
  | { error: 'places_unavailable' }
  | { error: 'geo_disabled' }

const inputSchema = {
  query: z.string().describe('What to search for, e.g. "潮汕鱼生", "late night ramen", "boba near campus"'),
  near: z.string().optional().describe('Area or address to search near (default: USC). e.g. "San Gabriel", "K-town"'),
  open_now: z.boolean().optional().describe('Only return places open right now'),
  min_rating: z.number().optional().describe('Minimum Google rating, 0-5'),
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function findPlacesHandler(input: {
  query: string
  near?: string
  open_now?: boolean
  min_rating?: number
  student_id?: string
}): Promise<string> {
  const query = String(input.query ?? '').trim()
  if (!query) return JSON.stringify({ places: [] })

  const studentId = String(input.student_id ?? '')
  if (!checkGeoBudget(studentId)) {
    return JSON.stringify({ error: 'geo_budget_exceeded' } satisfies FindPlacesError)
  }

  let near = USC_CENTER
  if (input.near) {
    const resolved = await resolveOrigin(input.near)
    // Unresolvable area → silently anchor at USC; a place search is still useful.
    if (!('error' in resolved)) near = resolved
  }

  try {
    const places = await placesTextSearch(query, {
      near,
      openNow: input.open_now,
      minRating: typeof input.min_rating === 'number' ? input.min_rating : undefined,
      limit: 5,
    })
    return JSON.stringify({ places })
  } catch (err) {
    if (err instanceof GeoError) {
      const code: FindPlacesError['error'] = err.code === 'geo_disabled' ? 'geo_disabled' : 'places_unavailable'
      return JSON.stringify({ error: code } satisfies FindPlacesError)
    }
    return JSON.stringify({ error: 'places_unavailable' } satisfies FindPlacesError)
  }
}

export const findPlacesTool = wrapTool({
  name: 'find_places',
  description:
    'Search the real world for places/food/spots by query (Google Places). Use this BEFORE saying you do not have something in your data — for restaurants, cafes, study spots, services, etc. Input: { query, near?, open_now?, min_rating? }. Returns { places: [{name, address, rating, reviews, priceLevel, openNow}] } (best-first, max 5) or an { error } object. Cite the place; never invent one not in the results.',
  schema: inputSchema,
  handler: findPlacesHandler,
})
