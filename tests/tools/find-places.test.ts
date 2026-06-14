// tests/tools/find-places.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
beforeEach(() => { vi.resetModules() })

class FakeGeoError extends Error { constructor(public code: string, m: string) { super(m) } }
class FakeYelpError extends Error { constructor(public code: string, m: string) { super(m) } }

type PR = {
  name: string; address: string; rating: number | null; reviews: number | null
  priceLevel: number | null; openNow: boolean | null; lat: number; lng: number
  url?: string | null; source?: 'google' | 'yelp'
}
const gp = (over: Partial<PR> = {}): PR => ({
  name: 'X', address: 'addr', rating: 4.0, reviews: 10, priceLevel: 2, openNow: null,
  lat: 34.09, lng: -118.08, url: null, source: 'google', ...over,
})

// Wire a find_places handler with both live sources stubbed.
async function load(opts: {
  google?: () => Promise<PR[]>
  yelp?: () => Promise<PR[]>
  budget?: boolean
}) {
  vi.doMock('../../src/services/geo-rate-limit.js', () => ({ checkGeoBudget: vi.fn(() => opts.budget ?? true) }))
  vi.doMock('../../src/services/google-maps.js', () => ({
    placesTextSearch: vi.fn(opts.google ?? (async () => [])),
    GeoError: FakeGeoError,
  }))
  vi.doMock('../../src/services/yelp.js', () => ({
    yelpBusinessSearch: vi.fn(opts.yelp ?? (async () => [])),
    YelpError: FakeYelpError,
  }))
  vi.doMock('../../src/tools/places.js', () => ({ resolveOrigin: vi.fn(async () => ({ lat: 34.09, lng: -118.08 })) }))
  return import('../../src/tools/find-places.js')
}

describe('mergePlaces', () => {
  it('collapses the same spot across sources and unions their sources', async () => {
    const { mergePlaces } = await load({})
    const g = [gp({ name: 'Yu Sheng House', source: 'google', url: null })]
    const y = [gp({ name: 'Yu Sheng House Restaurant', source: 'yelp', url: 'https://yelp/ysh', lat: 34.09001, lng: -118.08001 })]
    const out = mergePlaces([g, y], { limit: 5 })
    expect(out).toHaveLength(1)
    expect(out[0].sources.sort()).toEqual(['google', 'yelp'])
    expect(out[0].url).toBe('https://yelp/ysh') // back-filled from yelp
  })

  it('keeps distinct spots separate', async () => {
    const { mergePlaces } = await load({})
    const g = [gp({ name: 'A', lat: 34.09, lng: -118.08 })]
    const y = [gp({ name: 'B', source: 'yelp', lat: 34.05, lng: -118.02 })]
    expect(mergePlaces([g, y], { limit: 5 })).toHaveLength(2)
  })

  it('ranks a both-source agreement above a higher-rated single-source place', async () => {
    const { mergePlaces } = await load({})
    const g = [gp({ name: 'Agreed', rating: 4.0, lat: 34.09, lng: -118.08 }),
               gp({ name: 'SoloHigh', rating: 4.9, lat: 34.05, lng: -118.02 })]
    const y = [gp({ name: 'Agreed', source: 'yelp', rating: 4.0, lat: 34.09001, lng: -118.08001 })]
    const out = mergePlaces([g, y], { limit: 5 })
    expect(out[0].name).toBe('Agreed')      // 2 sources beats the 4.9 solo
    expect(out[0].sources).toHaveLength(2)
  })

  it('back-fills a null field from the matching source', async () => {
    const { mergePlaces } = await load({})
    const g = [gp({ name: 'Z', rating: null, lat: 34.09, lng: -118.08 })]
    const y = [gp({ name: 'Z', source: 'yelp', rating: 4.6, lat: 34.09, lng: -118.08 })]
    expect(mergePlaces([g, y])[0].rating).toBe(4.6)
  })

  it('filters the merged set by minRating', async () => {
    const { mergePlaces } = await load({})
    const g = [gp({ name: 'Low', rating: 3.4, lat: 34.09, lng: -118.08 }),
               gp({ name: 'High', rating: 4.7, lat: 34.05, lng: -118.02 })]
    expect(mergePlaces([g], { minRating: 4.0 }).map((p) => p.name)).toEqual(['High'])
  })

  it('defaults a missing source to google', async () => {
    const { mergePlaces } = await load({})
    const out = mergePlaces([[gp({ name: 'NoSrc', source: undefined })]])
    expect(out[0].sources).toEqual(['google'])
  })
})

describe('find_places handler', () => {
  it('returns the merged places JSON on a hit', async () => {
    const { findPlacesHandler } = await load({
      google: async () => [gp({ name: 'Yu Sheng House' })],
      yelp: async () => [],
    })
    const out = JSON.parse(await findPlacesHandler({ query: '潮汕鱼生', near: 'San Gabriel', student_id: 's1' }))
    expect(out.places[0].name).toBe('Yu Sheng House')
    expect(out.places[0].sources).toEqual(['google'])
  })

  it('serves Yelp results when Google throws', async () => {
    const { findPlacesHandler } = await load({
      google: async () => { throw new FakeGeoError('geo_unavailable', 'boom') },
      yelp: async () => [gp({ name: 'YelpSpot', source: 'yelp', url: 'https://yelp/s' })],
    })
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out.places[0].name).toBe('YelpSpot')
    expect(out.places[0].sources).toEqual(['yelp'])
  })

  it('serves Google results when Yelp throws (e.g. no YELP_API_KEY)', async () => {
    const { findPlacesHandler } = await load({
      google: async () => [gp({ name: 'GoogSpot' })],
      yelp: async () => { throw new FakeYelpError('yelp_disabled', 'no key') },
    })
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out.places[0].name).toBe('GoogSpot')
  })

  it('maps to places_unavailable only when BOTH sources fail', async () => {
    const { findPlacesHandler } = await load({
      google: async () => { throw new FakeGeoError('geo_unavailable', 'boom') },
      yelp: async () => { throw new FakeYelpError('yelp_unavailable', 'boom') },
    })
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out).toEqual({ error: 'places_unavailable' })
  })

  it('maps to geo_disabled when both fail and Google is key-disabled', async () => {
    const { findPlacesHandler } = await load({
      google: async () => { throw new FakeGeoError('geo_disabled', 'no key') },
      yelp: async () => { throw new FakeYelpError('yelp_disabled', 'no key') },
    })
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out).toEqual({ error: 'geo_disabled' })
  })

  it('returns empty places (not an error) when one source succeeds but finds nothing', async () => {
    const { findPlacesHandler } = await load({
      google: async () => [],
      yelp: async () => { throw new FakeYelpError('yelp_unavailable', 'boom') },
    })
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out).toEqual({ places: [] })
  })

  it('short-circuits to geo_budget_exceeded before any search', async () => {
    const google = vi.fn()
    const { findPlacesHandler } = await load({ budget: false, google })
    const out = JSON.parse(await findPlacesHandler({ query: 'x', student_id: 's1' }))
    expect(out).toEqual({ error: 'geo_budget_exceeded' })
    expect(google).not.toHaveBeenCalled()
  })

  it('empty query returns empty places without spending budget', async () => {
    const { findPlacesHandler } = await load({})
    const out = JSON.parse(await findPlacesHandler({ query: '   ', student_id: 's1' }))
    expect(out).toEqual({ places: [] })
  })
})
