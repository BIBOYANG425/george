import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
})

describe('distance_compare', () => {
  it('ranks alias-table places by distance with zero geocoder calls', async () => {
    const geocode = vi.fn()
    vi.doMock('../../src/services/google-maps.js', () => ({
      geocode,
      distanceMatrix: vi.fn(),
      GeoError: class extends Error {},
    }))
    const { distanceCompareHandler } = await import('../../src/tools/distance-compare.js')
    const out = JSON.parse(
      await distanceCompareHandler({
        from: 'annenberg',
        candidates: ['parkside', 'webb tower', 'ktown'],
      }),
    )
    expect(out.ranked).toHaveLength(3)
    // K-town is kilometers away; the two dorms are campus-adjacent.
    expect(out.ranked[2].place).toBe('ktown')
    expect(out.ranked[0].km).toBeLessThanOrEqual(out.ranked[1].km)
    expect(out.ranked[0].walk_minutes_estimate).toBeGreaterThan(0)
    expect(geocode).not.toHaveBeenCalled()
  })

  it('reports unknown places per-item without killing the ranking', async () => {
    vi.doMock('../../src/services/google-maps.js', () => ({
      geocode: vi.fn(async () => null),
      distanceMatrix: vi.fn(),
      GeoError: class extends Error {},
    }))
    const { distanceCompareHandler } = await import('../../src/tools/distance-compare.js')
    const out = JSON.parse(
      await distanceCompareHandler({
        from: 'leavey',
        candidates: ['parkside', 'totally made up noodle bar'],
      }),
    )
    expect(out.ranked).toHaveLength(1)
    expect(out.unresolved).toHaveLength(1)
    expect(out.unresolved[0].place).toBe('totally made up noodle bar')
  })

  it('respects the geo budget', async () => {
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({
      checkGeoBudget: vi.fn(() => false),
    }))
    const { distanceCompareHandler } = await import('../../src/tools/distance-compare.js')
    const out = JSON.parse(
      await distanceCompareHandler({
        from: 'leavey',
        candidates: ['parkside', 'webb tower'],
        student_id: 's1',
      }),
    )
    expect(out.error).toBe('geo_budget_exceeded')
  })

  it('labels the output as straight-line, pointing to travel_time for exact claims', async () => {
    // doMock registrations persist across tests in this file; re-mock the
    // budget as open so the previous test's checkGeoBudget=false doesn't leak.
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({
      checkGeoBudget: vi.fn(() => true),
    }))
    const { distanceCompareHandler } = await import('../../src/tools/distance-compare.js')
    const out = JSON.parse(
      await distanceCompareHandler({ from: 'leavey', candidates: ['parkside', 'webb tower'] }),
    )
    expect(out.note).toMatch(/straight-line/i)
    expect(out.note).toMatch(/travel_time/)
  })
})
