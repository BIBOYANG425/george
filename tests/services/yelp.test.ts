import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

beforeEach(() => { vi.resetModules(); process.env.YELP_API_KEY = 'test-key' })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.YELP_API_KEY })

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({ ok, status, json: async () => body }))
  vi.stubGlobal('fetch', fn)
  return fn
}

const biz = (over: Record<string, unknown> = {}) => ({
  name: 'Yu Sheng House',
  rating: 4.6,
  review_count: 210,
  price: '$$',
  location: { display_address: ['123 Valley Blvd', 'San Gabriel, CA 91776'] },
  coordinates: { latitude: 34.09, longitude: -118.08 },
  url: 'https://www.yelp.com/biz/yu-sheng-house',
  is_closed: false,
  ...over,
})

describe('yelpBusinessSearch', () => {
  it('maps a business into the PlaceResult shape with source + url', async () => {
    mockFetch({ businesses: [biz()] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    const out = await yelpBusinessSearch('潮汕鱼生', { near: { lat: 34.09, lng: -118.08 } })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      name: 'Yu Sheng House',
      address: '123 Valley Blvd, San Gabriel, CA 91776',
      rating: 4.6,
      reviews: 210,
      priceLevel: 2,           // '$$' → 2
      lat: 34.09,
      lng: -118.08,
      url: 'https://www.yelp.com/biz/yu-sheng-house',
      source: 'yelp',
    })
  })

  it('maps price tiers $..$$$$ to 1..4 and absent price to null', async () => {
    mockFetch({ businesses: [
      biz({ name: 'A', price: '$' }),
      biz({ name: 'B', price: '$$$$' }),
      biz({ name: 'C', price: undefined }),
    ] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    const out = await yelpBusinessSearch('x', { near: { lat: 34, lng: -118 } })
    expect(out.map((p) => p.priceLevel)).toEqual([1, 4, null])
  })

  it('sets openNow true when open_now filter was requested, else null', async () => {
    mockFetch({ businesses: [biz()] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    const open = await yelpBusinessSearch('x', { near: { lat: 34, lng: -118 }, openNow: true })
    expect(open[0].openNow).toBe(true)

    vi.resetModules()
    mockFetch({ businesses: [biz()] })
    const { yelpBusinessSearch: again } = await import('../../src/services/yelp.js')
    const unknown = await again('x', { near: { lat: 34, lng: -118 } })
    expect(unknown[0].openNow).toBe(null)
  })

  it('drops businesses missing name or coordinates', async () => {
    mockFetch({ businesses: [
      biz({ name: '' }),
      biz({ name: 'NoCoords', coordinates: { latitude: null, longitude: null } }),
      biz({ name: 'Good' }),
    ] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    const out = await yelpBusinessSearch('x', { near: { lat: 34, lng: -118 } })
    expect(out.map((p) => p.name)).toEqual(['Good'])
  })

  it('returns [] when Yelp returns no businesses', async () => {
    mockFetch({ businesses: [] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    expect(await yelpBusinessSearch('nope', { near: { lat: 34, lng: -118 } })).toEqual([])
  })

  it('throws yelp_disabled when the key is unset', async () => {
    delete process.env.YELP_API_KEY
    const { yelpBusinessSearch, YelpError } = await import('../../src/services/yelp.js')
    await expect(yelpBusinessSearch('x')).rejects.toBeInstanceOf(YelpError)
    await expect(yelpBusinessSearch('x')).rejects.toHaveProperty('code', 'yelp_disabled')
  })

  it('throws yelp_unavailable on a non-OK HTTP status', async () => {
    mockFetch({}, false, 429)
    const { yelpBusinessSearch, YelpError } = await import('../../src/services/yelp.js')
    await expect(yelpBusinessSearch('x', { near: { lat: 34, lng: -118 } })).rejects.toBeInstanceOf(YelpError)
  })

  it('caches within the hour — a repeat query does not refetch', async () => {
    const fetchFn = mockFetch({ businesses: [biz()] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    await yelpBusinessSearch('潮汕鱼生', { near: { lat: 34.09, lng: -118.08 } })
    await yelpBusinessSearch('潮汕鱼生', { near: { lat: 34.09, lng: -118.08 } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sends the bearer key and search params', async () => {
    const fetchFn = mockFetch({ businesses: [biz()] })
    const { yelpBusinessSearch } = await import('../../src/services/yelp.js')
    await yelpBusinessSearch('ramen', { near: { lat: 34.02, lng: -118.28 }, openNow: true })
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toContain('https://api.yelp.com/v3/businesses/search')
    expect(String(url)).toContain('term=ramen')
    expect(String(url)).toContain('latitude=34.02')
    expect(String(url)).toContain('open_now=true')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })
})
