// src/tools/dps-zone-check.ts
// dps_zone_check: which DPS patrol zone (if any) contains a named place.
// Zone polygons come from data/dps-zones-v1.geojson (hand-compiled from the
// official DPS map). When that file is absent, returns zone_data_unavailable
// — george must say he doesn't have the zone map, NEVER guess a zone.
//
// Header last reviewed: 2026-06-10

import { z } from 'zod'
import { wrapTool } from './_wrap.js'
import { resolveOrigin } from './places.js'
import { loadDpsZones, zoneForPoint, isLyftHoursActive } from '../services/spatial.js'

const inputSchema = {
  place: z.string().describe('Place name, USC alias, or address to check'),
}

export async function dpsZoneCheckHandler(input: { place: string }): Promise<string> {
  const loc = await resolveOrigin(String(input.place ?? ''))
  if ('error' in loc) return JSON.stringify(loc)

  const zones = await loadDpsZones()
  if (zones === null) {
    return JSON.stringify({
      error: 'zone_data_unavailable',
      hint: 'DPS zone map not loaded — do not guess a zone. The 8pm-3am free share-Lyft program still applies inside the DPS patrol area.',
    })
  }

  const zone = zoneForPoint(loc, zones)
  if (!zone) {
    return JSON.stringify({
      in_dps_coverage: false,
      hint: 'outside DPS patrol coverage — no free share Lyft from here',
    })
  }
  return JSON.stringify({
    in_dps_coverage: true,
    zone: zone.name,
    risk: zone.risk,
    lyft_hours_active_now: isLyftHoursActive(),
  })
}

export const dpsZoneCheckTool = wrapTool({
  name: 'dps_zone_check',
  description:
    'Check whether a place falls inside the USC DPS patrol zone (free share-Lyft 8pm-3am) and which zone. Use BEFORE making any claim about DPS coverage or zone membership. May return zone_data_unavailable — then say you do not have the zone map.',
  schema: inputSchema,
  handler: dpsZoneCheckHandler,
})
