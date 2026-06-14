// Thin Yelp Places API client (the REST API formerly "Yelp Fusion").
// One endpoint: GET /v3/businesses/search. Returns results in the same
// PlaceResult shape as google-maps.ts so find_places can merge the two sources.
// A 1-hour LRU cache keeps repeat queries cheap; errors carry a `code` so the
// caller maps them to a tool error. Phase 2 of the real-world search work.
//
// Header last reviewed: 2026-06-13

import { LRUCache } from 'lru-cache'
import { log } from '../observability/logger.js'
import type { PlaceResult } from './google-maps.js'

const API_TTL_MS = 60 * 60 * 1000 // 1 hour
const TIMEOUT_MS = 3000
const YELP_MAX_RADIUS = 40000 // meters (Yelp API cap)
const YELP_MAX_LIMIT = 50

const apiCache = new LRUCache<string, PlaceResult[]>({ max: 1000, ttl: API_TTL_MS })

export class YelpError extends Error {
  constructor(
    public code: 'yelp_disabled' | 'yelp_unavailable',
    message: string,
  ) {
    super(message)
  }
}

export interface YelpSearchOpts {
  near?: { lat: number; lng: number }
  radiusMeters?: number
  openNow?: boolean
  limit?: number
}

function requireKey(): string {
  const key = process.env.YELP_API_KEY
  if (!key) throw new YelpError('yelp_disabled', 'YELP_API_KEY not set')
  return key
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return res
      if (res.status >= 500 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (res.status === 429 || res.status === 403) {
        log('warn', 'yelp_billing_blocked', { status: res.status })
      }
      throw new YelpError('yelp_unavailable', `Yelp ${res.status}`)
    } catch (err) {
      if (err instanceof YelpError) throw err
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      throw new YelpError('yelp_unavailable', (err as Error).message)
    }
  }
  throw new YelpError('yelp_unavailable', 'exhausted retries')
}

// "$".."$$$$" → 1..4; anything else → null.
function priceTier(price: unknown): number | null {
  if (typeof price === 'string' && /^\$+$/.test(price) && price.length <= 4) return price.length
  return null
}

interface YelpBusiness {
  name?: string
  rating?: number
  review_count?: number
  price?: string
  location?: { display_address?: string[] }
  coordinates?: { latitude?: number | null; longitude?: number | null }
  url?: string
}

// Yelp Places API business search. Returns up to `limit` mapped results in the
// PlaceResult shape (source: 'yelp'). Throws YelpError('yelp_disabled') when the
// key is unset, YelpError('yelp_unavailable') on a non-OK status.
export async function yelpBusinessSearch(
  term: string,
  opts: YelpSearchOpts = {},
): Promise<PlaceResult[]> {
  const limit = Math.min(opts.limit ?? 8, YELP_MAX_LIMIT)
  const radius = Math.min(opts.radiusMeters ?? 16000, YELP_MAX_RADIUS)
  const near = opts.near
  const cacheKey = `yelp|${term.toLowerCase().trim()}|${near ? `${near.lat.toFixed(5)},${near.lng.toFixed(5)}` : ''}|${radius}|${opts.openNow ? '1' : ''}|${limit}`
  const cached = apiCache.get(cacheKey)
  if (cached) return cached

  const key = requireKey()
  const params = new URLSearchParams({ term, limit: String(limit) })
  if (near) {
    params.set('latitude', String(near.lat))
    params.set('longitude', String(near.lng))
    params.set('radius', String(radius))
  }
  if (opts.openNow) params.set('open_now', 'true')

  const url = `https://api.yelp.com/v3/businesses/search?${params.toString()}`
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  const data = (await res.json()) as { businesses?: YelpBusiness[] }

  const places: PlaceResult[] = (data.businesses ?? [])
    .map((b): PlaceResult => ({
      name: b.name ?? '',
      address: (b.location?.display_address ?? []).join(', '),
      rating: typeof b.rating === 'number' ? b.rating : null,
      reviews: typeof b.review_count === 'number' ? b.review_count : null,
      priceLevel: priceTier(b.price),
      // Yelp search has no per-business "open now" unless we filtered on it.
      // is_closed means *permanently* closed, so it is not an open-now signal.
      openNow: opts.openNow ? true : null,
      lat: typeof b.coordinates?.latitude === 'number' ? b.coordinates.latitude : 0,
      lng: typeof b.coordinates?.longitude === 'number' ? b.coordinates.longitude : 0,
      url: b.url ?? null,
      source: 'yelp',
    }))
    .filter((p) => p.name && p.lat !== 0 && p.lng !== 0)

  apiCache.set(cacheKey, places)
  return places
}

export const _internal = { apiCache }
