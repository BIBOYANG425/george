import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

beforeEach(() => { vi.resetModules(); process.env.GOOGLE_MAPS_API_KEY = 'test-key' })
afterEach(() => { vi.unstubAllGlobals() })

function mockFetch(body: unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })))
}

describe('placesTextSearch', () => {
  it('maps, sorts best-first, and caps results', async () => {
    mockFetch({ status: 'OK', results: [
      { name: 'A', formatted_address: 'addr A', rating: 4.2, user_ratings_total: 100, price_level: 2, opening_hours: { open_now: true }, geometry: { location: { lat: 34.02, lng: -118.28 } } },
      { name: 'B', formatted_address: 'addr B', rating: 4.7, user_ratings_total: 50, geometry: { location: { lat: 34.03, lng: -118.29 } } },
    ] })
    const { placesTextSearch } = await import('../../src/services/google-maps.js')
    const out = await placesTextSearch('鱼生', { limit: 5 })
    expect(out[0].name).toBe('B')           // higher rating sorts first
    expect(out[0].openNow).toBe(null)
    expect(out[1].openNow).toBe(true)
    expect(out).toHaveLength(2)
  })

  it('returns [] on ZERO_RESULTS', async () => {
    mockFetch({ status: 'ZERO_RESULTS', results: [] })
    const { placesTextSearch } = await import('../../src/services/google-maps.js')
    expect(await placesTextSearch('nope')).toEqual([])
  })

  it('throws GeoError on non-OK API status', async () => {
    mockFetch({ status: 'REQUEST_DENIED' })
    const { placesTextSearch, GeoError } = await import('../../src/services/google-maps.js')
    await expect(placesTextSearch('x')).rejects.toBeInstanceOf(GeoError)
  })

  it('filters by minRating', async () => {
    mockFetch({ status: 'OK', results: [
      { name: 'Low', formatted_address: 'a', rating: 3.5, geometry: { location: { lat: 34.02, lng: -118.28 } } },
      { name: 'High', formatted_address: 'b', rating: 4.6, geometry: { location: { lat: 34.03, lng: -118.29 } } },
    ] })
    const { placesTextSearch } = await import('../../src/services/google-maps.js')
    const out = await placesTextSearch('x', { minRating: 4.0 })
    expect(out.map((p) => p.name)).toEqual(['High'])
  })

  it('throws geo_disabled when the key is unset', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY
    const { placesTextSearch } = await import('../../src/services/google-maps.js')
    await expect(placesTextSearch('x')).rejects.toThrow(/GOOGLE_MAPS_API_KEY/)
  })
})
