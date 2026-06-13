// tests/tools/find-places.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
beforeEach(() => { vi.resetModules() })

class FakeGeoError extends Error { constructor(public code: string, m: string) { super(m) } }

describe('find_places', () => {
  it('returns curated places JSON on a hit', async () => {
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({ checkGeoBudget: vi.fn(() => true) }))
    vi.doMock('../../src/services/google-maps.js', () => ({
      placesTextSearch: vi.fn(async () => [{ name: 'Yu Sheng House', address: '123 Valley Blvd', rating: 4.6, reviews: 200, priceLevel: 2, openNow: true, lat: 34.1, lng: -118.1 }]),
      GeoError: FakeGeoError,
    }))
    vi.doMock('../../src/tools/places.js', () => ({ resolveOrigin: vi.fn(async () => ({ lat: 34.09, lng: -118.08 })) }))
    const { findPlacesHandler } = await import('../../src/tools/find-places.js')
    const out = JSON.parse(await findPlacesHandler({ query: '潮汕鱼生', near: 'San Gabriel', student_id: 's1' }))
    expect(out.places[0].name).toBe('Yu Sheng House')
  })

  it('short-circuits to geo_budget_exceeded before any search', async () => {
    const search = vi.fn()
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({ checkGeoBudget: vi.fn(() => false) }))
    vi.doMock('../../src/services/google-maps.js', () => ({ placesTextSearch: search, GeoError: FakeGeoError }))
    vi.doMock('../../src/tools/places.js', () => ({ resolveOrigin: vi.fn() }))
    const { findPlacesHandler } = await import('../../src/tools/find-places.js')
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out).toEqual({ error: 'geo_budget_exceeded' })
    expect(search).not.toHaveBeenCalled()
  })

  it('maps an upstream GeoError to places_unavailable', async () => {
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({ checkGeoBudget: vi.fn(() => true) }))
    vi.doMock('../../src/services/google-maps.js', () => ({
      placesTextSearch: vi.fn(async () => { throw new FakeGeoError('geo_unavailable', 'boom') }),
      GeoError: FakeGeoError,
    }))
    vi.doMock('../../src/tools/places.js', () => ({ resolveOrigin: vi.fn(async () => ({ lat: 34, lng: -118 })) }))
    const { findPlacesHandler } = await import('../../src/tools/find-places.js')
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out).toEqual({ error: 'places_unavailable' })
  })

  it('empty query returns empty places without spending budget', async () => {
    const budget = vi.fn(() => true)
    vi.doMock('../../src/services/geo-rate-limit.js', () => ({ checkGeoBudget: budget }))
    vi.doMock('../../src/services/google-maps.js', () => ({ placesTextSearch: vi.fn(), GeoError: FakeGeoError }))
    vi.doMock('../../src/tools/places.js', () => ({ resolveOrigin: vi.fn() }))
    const { findPlacesHandler } = await import('../../src/tools/find-places.js')
    const out = JSON.parse(await findPlacesHandler({ query: '   ', student_id: 's1' }))
    expect(out).toEqual({ places: [] })
    expect(budget).not.toHaveBeenCalled()
  })
})
