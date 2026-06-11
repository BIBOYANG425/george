// src/services/spatial.ts
// Pure-TS spatial math + DPS zone data for Slice A. No DB, no Google calls.
// Locations come from usc-aliases.ts (36 hand-verified coordinates); zone
// polygons come from data/dps-zones-v1.geojson, hand-compiled from the
// official DPS patrol map. If that file is absent the zone functions return
// null/unavailable — callers must surface that honestly, never guess a zone.
//
// Header last reviewed: 2026-06-10

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface LatLng {
  lat: number
  lng: number
}

export interface DpsZone {
  name: string
  risk: 'green' | 'yellow' | 'red'
  // GeoJSON ring: [lng, lat] pairs, first === last.
  ring: Array<[number, number]>
}

const EARTH_RADIUS_KM = 6371
// Straight-line distance underestimates street walking; 1.3 is the standard
// urban-grid detour factor. 4.8 km/h ≈ typical student walking pace.
const ROUTE_FACTOR = 1.3
const WALK_KMH = 4.8

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

// Estimate, not a routed time — distance_compare/safe_route label it as such.
// travel_time (Google Routes) remains the source for exact claims.
export function walkingMinutesEstimate(a: LatLng, b: LatLng): number {
  return Math.round((haversineKm(a, b) * ROUTE_FACTOR * 60) / WALK_KMH)
}

// Ray-casting point-in-polygon. ring is [lng, lat] pairs (GeoJSON order).
// Boundary points count as inside — for a safety boundary, the conservative
// reading of "on the edge of the patrol zone" is "covered".
export function pointInRing(point: LatLng, ring: Array<[number, number]>): boolean {
  const x = point.lng
  const y = point.lat
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    // On-vertex / on-edge check (within ~1e-9 deg) → inside.
    if (Math.abs(xi - x) < 1e-9 && Math.abs(yi - y) < 1e-9) return true
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

// ── DPS zone data ─────────────────────────────────────────────────────

export const DPS_ZONES_PATH = path.resolve(
  process.env.DPS_ZONES_PATH ?? 'data/dps-zones-v1.geojson',
)

let zonesCache: DpsZone[] | null | undefined

interface GeoJsonFeatureCollection {
  type: string
  features: Array<{
    type: string
    geometry: { type: string; coordinates: Array<Array<[number, number]>> }
    properties: { name?: string; risk?: string }
  }>
}

function parseZones(raw: string, sourcePath: string): DpsZone[] {
  const parsed = JSON.parse(raw) as GeoJsonFeatureCollection
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`${sourcePath}: expected a GeoJSON FeatureCollection`)
  }
  return parsed.features.map((f, idx) => {
    if (f.geometry?.type !== 'Polygon' || !Array.isArray(f.geometry.coordinates?.[0])) {
      throw new Error(`${sourcePath}: feature ${idx} is not a Polygon`)
    }
    const risk = f.properties?.risk
    if (risk !== 'green' && risk !== 'yellow' && risk !== 'red') {
      throw new Error(`${sourcePath}: feature ${idx} risk must be green|yellow|red`)
    }
    return {
      name: f.properties?.name ?? `zone-${idx}`,
      risk,
      ring: f.geometry.coordinates[0],
    }
  })
}

// Returns null when the zone file doesn't exist yet (pre-launch state) —
// callers translate that to zone_data_unavailable, never to a guess.
// A malformed file throws: bad safety data should fail loudly, not silently
// behave like no data.
export async function loadDpsZones(filePath: string = DPS_ZONES_PATH): Promise<DpsZone[] | null> {
  if (zonesCache !== undefined && filePath === DPS_ZONES_PATH) return zonesCache
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    if (filePath === DPS_ZONES_PATH) zonesCache = null
    return null
  }
  const zones = parseZones(raw, filePath)
  if (filePath === DPS_ZONES_PATH) zonesCache = zones
  return zones
}

// Test seam: reset the module-level cache.
export function clearZonesCacheForTest(): void {
  zonesCache = undefined
}

export function zoneForPoint(point: LatLng, zones: DpsZone[]): DpsZone | null {
  return zones.find((z) => pointInRing(point, z.ring)) ?? null
}

// ── DPS share-Lyft hours (AGENT.md safety circle: 20:00–03:00 LA) ────

export const LYFT_START_HOUR = 20
export const LYFT_END_HOUR = 3

export function laHour(date: Date): number {
  // hourCycle h23 (not hour12:false) — the latter can render midnight as "24"
  // on some ICU versions, which would break the 20:00-03:00 window math.
  return Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'America/Los_Angeles',
    }).format(date),
  )
}

export function isLyftHoursActive(date: Date = new Date()): boolean {
  const h = laHour(date)
  return h >= LYFT_START_HOUR || h < LYFT_END_HOUR
}
