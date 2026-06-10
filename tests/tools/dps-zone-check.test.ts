import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/dps-zones-sample.geojson')

beforeEach(() => {
  vi.resetModules()
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
})

describe('dps_zone_check', () => {
  it('returns zone membership for a known alias inside a fixture zone', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    const { dpsZoneCheckHandler } = await import('../../src/tools/dps-zone-check.js')
    // Tommy Trojan (34.020, -118.285) sits inside Test Zone Campus.
    const out = JSON.parse(await dpsZoneCheckHandler({ place: 'tommy trojan' }))
    expect(out.in_dps_coverage).toBe(true)
    expect(out.zone).toBe('Test Zone Campus')
    expect(out.risk).toBe('green')
  })

  it('reports outside coverage for K-town', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    const { dpsZoneCheckHandler } = await import('../../src/tools/dps-zone-check.js')
    const out = JSON.parse(await dpsZoneCheckHandler({ place: 'ktown' }))
    expect(out.in_dps_coverage).toBe(false)
  })

  it('returns zone_data_unavailable when the zone file is missing — never guesses', async () => {
    process.env.DPS_ZONES_PATH = '/nonexistent/dps-zones-v1.geojson'
    const { dpsZoneCheckHandler } = await import('../../src/tools/dps-zone-check.js')
    const out = JSON.parse(await dpsZoneCheckHandler({ place: 'tommy trojan' }))
    expect(out.error).toBe('zone_data_unavailable')
    expect(out.in_dps_coverage).toBeUndefined()
    expect(out.zone).toBeUndefined()
  })

  it('fails closed on unknown short acronyms instead of geocoding garbage', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    vi.doMock('../../src/services/google-maps.js', () => ({
      geocode: vi.fn(),
      distanceMatrix: vi.fn(),
      GeoError: class extends Error {},
    }))
    const { dpsZoneCheckHandler } = await import('../../src/tools/dps-zone-check.js')
    const out = JSON.parse(await dpsZoneCheckHandler({ place: 'zzq' }))
    expect(out.error).toBe('need_location')
  })
})
