import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/dps-zones-sample.geojson')

beforeEach(() => {
  vi.resetModules()
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
})

describe('safe_route', () => {
  it('late-night walk inside coverage: zone facts + active Lyft hours', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    const { safeRouteHandler } = await import('../../src/tools/safe-route.js')
    const out = JSON.parse(
      await safeRouteHandler({ to: 'leavey', from: 'parkside', at_hour: 23 }),
    )
    expect(out.lyft_hours_active).toBe(true)
    expect(out.zone_data_available).toBe(true)
    expect(out.in_dps_coverage).toBe(true)
    expect(out.zone).toMatchObject({ name: 'Test Zone Campus', risk: 'green' })
    expect(out.walk_minutes_estimate).toBeGreaterThan(0)
  })

  it('11am walk: Lyft hours inactive', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    const { safeRouteHandler } = await import('../../src/tools/safe-route.js')
    const out = JSON.parse(await safeRouteHandler({ to: 'leavey', at_hour: 11 }))
    expect(out.lyft_hours_active).toBe(false)
  })

  it('destination outside coverage reports in_dps_coverage false', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    const { safeRouteHandler } = await import('../../src/tools/safe-route.js')
    const out = JSON.parse(await safeRouteHandler({ to: 'ktown', at_hour: 22 }))
    expect(out.in_dps_coverage).toBe(false)
    expect(out.zone).toBeNull()
  })

  it('missing zone file: still gives walk estimate + Lyft hours, marks zone data unavailable', async () => {
    process.env.DPS_ZONES_PATH = '/nonexistent/dps-zones-v1.geojson'
    const { safeRouteHandler } = await import('../../src/tools/safe-route.js')
    const out = JSON.parse(await safeRouteHandler({ to: 'leavey', at_hour: 23 }))
    expect(out.zone_data_available).toBe(false)
    expect(out.in_dps_coverage).toBeNull()
    expect(out.zone).toBeNull()
    expect(out.lyft_hours_active).toBe(true)
    expect(out.walk_minutes_estimate).toBeGreaterThan(0)
    expect(out.note).toMatch(/do not claim zone membership/i)
  })

  it('defaults origin to UPC when from is omitted', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    const { safeRouteHandler } = await import('../../src/tools/safe-route.js')
    const out = JSON.parse(await safeRouteHandler({ to: 'frat row', at_hour: 21 }))
    expect(out.walk_minutes_estimate).toBeLessThan(20)
  })

  it('respects the geo budget', async () => {
    process.env.DPS_ZONES_PATH = FIXTURE
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({
      checkGeoBudget: vi.fn(() => false),
    }))
    const { safeRouteHandler } = await import('../../src/tools/safe-route.js')
    const out = JSON.parse(await safeRouteHandler({ to: 'leavey', student_id: 's1' }))
    expect(out.error).toBe('geo_budget_exceeded')
  })
})
