// src/tools/find-places.ts
// find_places: real-world place/food/spot search merged across two live sources —
// Google Places text search and the Yelp Places API. Results are de-duplicated by
// name+proximity and ranked so places both sources agree on float to the top.
// Output is JSON-stringified; errors surface as { error } objects, never thrown
// (matches the other geo tools). One failing source never sinks the other — the
// call only errors when BOTH fail. Reuses the geo budget (one unit per call) and
// resolveOrigin to anchor the search area, defaulting to USC campus.
//
// Header last reviewed: 2026-06-13
import { z } from 'zod'
import { placesTextSearch, GeoError, type PlaceResult } from '../services/google-maps.js'
import { yelpBusinessSearch } from '../services/yelp.js'
import { checkGeoBudget } from '../services/geo-rate-limit.js'
import { resolveOrigin } from './places.js'
import { wrapTool } from './_wrap.js'

// USC University Park campus center — default anchor when no area is named.
const USC_CENTER = { lat: 34.0224, lng: -118.2851 }
const RESULT_LIMIT = 5
// Pull a few extra per source so the merge has headroom before capping.
const SOURCE_LIMIT = 8
// Two candidates count as the same physical spot within this radius.
const SAME_SPOT_METERS = 50

type FindPlacesError =
  | { error: 'geo_budget_exceeded' }
  | { error: 'places_unavailable' }
  | { error: 'geo_disabled' }

export type MergedPlace = PlaceResult & { sources: string[] }

const inputSchema = {
  query: z.string().describe('What to search for, e.g. "潮汕鱼生", "late night ramen", "boba near campus"'),
  near: z.string().optional().describe('Area or address to search near (default: USC). e.g. "San Gabriel", "K-town"'),
  open_now: z.boolean().optional().describe('Only return places open right now'),
  min_rating: z.number().optional().describe('Minimum rating, 0-5'),
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

// Normalize a place name for dedup: lowercase, strip diacritics, keep only
// [a-z0-9] and CJK so "Yú Shēng House!" and "yu sheng house" collapse.
function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .replace(/[^a-z0-9一-鿿]/g, '') // keep alphanumerics + CJK
}

function haversineMeters(a: PlaceResult, b: PlaceResult): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Same physical spot when within SAME_SPOT_METERS and the normalized names match
// or one contains the other (handles "Yu Sheng House" vs "Yu Sheng House Restaurant").
function sameSpot(a: PlaceResult, b: PlaceResult): boolean {
  if (haversineMeters(a, b) > SAME_SPOT_METERS) return false
  const na = normName(a.name)
  const nb = normName(b.name)
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

// Merge candidate lists from multiple sources into one de-duplicated, ranked set.
// First occurrence of a spot is primary; later matches add their source and
// back-fill any missing field. Ranked agreement-first, then rating, then reviews.
export function mergePlaces(
  lists: PlaceResult[][],
  opts: { minRating?: number; limit?: number } = {},
): MergedPlace[] {
  const merged: MergedPlace[] = []
  for (const p of lists.flat()) {
    const src = p.source ?? 'google'
    const hit = merged.find((m) => sameSpot(m, p))
    if (hit) {
      if (!hit.sources.includes(src)) hit.sources.push(src)
      hit.rating ??= p.rating
      hit.reviews ??= p.reviews
      hit.priceLevel ??= p.priceLevel
      hit.url ??= p.url ?? null
      if (p.openNow) hit.openNow = true
    } else {
      merged.push({ ...p, source: src, url: p.url ?? null, sources: [src] })
    }
  }

  let out = merged
  if (typeof opts.minRating === 'number') {
    const min = opts.minRating
    out = out.filter((m) => (m.rating ?? 0) >= min)
  }
  out = [...out].sort(
    (a, b) =>
      b.sources.length - a.sources.length ||
      (b.rating ?? 0) - (a.rating ?? 0) ||
      (b.reviews ?? 0) - (a.reviews ?? 0),
  )
  return out.slice(0, opts.limit ?? RESULT_LIMIT)
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

  const minRating = typeof input.min_rating === 'number' ? input.min_rating : undefined

  // Fire both live sources at once. allSettled so a failing/un-keyed source
  // (e.g. Yelp with no YELP_API_KEY) never sinks the other.
  const [googleRes, yelpRes] = await Promise.allSettled([
    placesTextSearch(query, { near, openNow: input.open_now, minRating, limit: SOURCE_LIMIT }),
    yelpBusinessSearch(query, { near, openNow: input.open_now, limit: SOURCE_LIMIT }),
  ])

  const lists: PlaceResult[][] = []
  if (googleRes.status === 'fulfilled') lists.push(googleRes.value)
  if (yelpRes.status === 'fulfilled') lists.push(yelpRes.value)

  const places = mergePlaces(lists, { minRating, limit: RESULT_LIMIT })
  if (places.length > 0) return JSON.stringify({ places })

  // No results. If BOTH sources failed, surface an error; if at least one
  // succeeded but the merged set is empty, that's a legit "found nothing".
  if (googleRes.status === 'rejected' && yelpRes.status === 'rejected') {
    const gErr = googleRes.reason
    if (gErr instanceof GeoError && gErr.code === 'geo_disabled') {
      return JSON.stringify({ error: 'geo_disabled' } satisfies FindPlacesError)
    }
    return JSON.stringify({ error: 'places_unavailable' } satisfies FindPlacesError)
  }
  return JSON.stringify({ places: [] })
}

export const findPlacesTool = wrapTool({
  name: 'find_places',
  description:
    'Search the real world for places/food/spots by query, merged across Google Places and Yelp. Use this BEFORE saying you do not have something in your data — for restaurants, cafes, study spots, services, etc. Input: { query, near?, open_now?, min_rating? }. Returns { places: [{name, address, rating, reviews, priceLevel, openNow, url, sources}] } (best-first, max 5; `sources` lists which of google/yelp back the place) or an { error } object. Cite the place; never invent one not in the results.',
  schema: inputSchema,
  handler: findPlacesHandler,
})
