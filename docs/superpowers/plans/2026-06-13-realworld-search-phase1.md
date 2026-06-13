# Real-World Search (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give george live real-world search — `find_places` (Google Places) for spots/food and the SDK's built-in `WebSearch` for open-web facts — so it answers "find me a 潮汕鱼生 in LA" with real, cited results instead of "I don't have that."

**Architecture:** Two additive capabilities wired into the existing 3-subagent setup. `placesTextSearch` is a new method on the existing Maps service; `find_places` wraps it as a george tool (What's Happening + Know Things). `WebSearch` is the SDK built-in, enabled for those same two sub-agents, biased to trusted domains via a dynamic prompt block, rationed by a per-student daily budget recorded from the turn's `usage.server_tool_use.web_search_requests`.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (built-in `WebSearch`), Google Places Text Search, zod, vitest. Follows existing `wrapTool` / `{error}`-never-throw / `vi.doMock` patterns.

**Spec:** `docs/superpowers/specs/2026-06-13-realworld-search-design.md`
**Branch:** `feat/realworld-search`

---

## File map

| File | Responsibility | Action |
|---|---|---|
| `src/services/google-maps.ts` | + `placesTextSearch()` + `PlaceResult` | Modify |
| `src/tools/find-places.ts` | `find_places` tool | Create |
| `src/tools/index.ts` | register `find_places` in `ALL_TOOLS` | Modify |
| `src/agent/agents.config.ts` | add `find_places` to whats-happening + know-things tool lists | Modify |
| `src/services/web-search-budget.ts` | per-student daily WebSearch budget | Create |
| `src/services/web-search-config.ts` | `trustedDomains()` allowlist | Create |
| `src/agent/orchestrator.ts` | enable `WebSearch` + budget gate + dynamic web-search guidance; export `buildAgentsConfig` | Modify |
| `prompts/master.md`, `prompts/whats-happening.md`, `prompts/know-things.md` | "look before you say 没有数据" routing | Modify |
| `tests/services/google-maps-places.test.ts` | placesTextSearch | Create |
| `tests/tools/find-places.test.ts` | find_places handler | Create |
| `tests/services/web-search-budget.test.ts` | budget | Create |
| `tests/services/web-search-config.test.ts` | trusted domains | Create |
| `tests/agent/orchestrator.test.ts` | web/find_places wiring | Modify |

---

### Task 1: `placesTextSearch` on the Maps service

**Files:**
- Modify: `src/services/google-maps.ts` (add before the `_internal` export at line ~151)
- Test: `tests/services/google-maps-places.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/google-maps-places.test.ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/google-maps-places.test.ts`
Expected: FAIL — `placesTextSearch is not a function`.

- [ ] **Step 3: Implement `placesTextSearch`**

Insert into `src/services/google-maps.ts` immediately before the `// Exported for Task 5…` `_internal` line. `requireKey`, `fetchWithRetry`, `apiCache`, `llKey`, `LatLng`, and `GeoError` are already in scope in this file.

```ts
export interface PlaceResult {
  name: string
  address: string
  rating: number | null
  reviews: number | null
  priceLevel: number | null
  openNow: boolean | null
  lat: number
  lng: number
}

function applyPlaceFilters(
  places: PlaceResult[],
  opts: { minRating?: number },
  limit: number,
): PlaceResult[] {
  let out = places
  if (typeof opts.minRating === 'number') {
    const min = opts.minRating
    out = out.filter((p) => (p.rating ?? 0) >= min)
  }
  out = [...out].sort(
    (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.reviews ?? 0) - (a.reviews ?? 0),
  )
  return out.slice(0, limit)
}

// Google Places Text Search. Returns up to `limit` mapped results, best-first
// (rating desc, then review count). The full mapped set is cached (1h, shared
// apiCache); minRating/limit are applied per-call so variants reuse the cache.
// Throws GeoError('geo_disabled') when the key is unset, GeoError('geo_unavailable')
// on a non-OK API status (mirrors geocode/distanceMatrix).
export async function placesTextSearch(
  query: string,
  opts: { near?: LatLng; radiusMeters?: number; openNow?: boolean; minRating?: number; limit?: number } = {},
): Promise<PlaceResult[]> {
  const limit = opts.limit ?? 5
  const cacheKey = `places|${query.toLowerCase().trim()}|${opts.near ? llKey(opts.near) : ''}|${opts.radiusMeters ?? ''}|${opts.openNow ? '1' : ''}`
  const cached = apiCache.get(cacheKey) as PlaceResult[] | undefined
  if (cached) return applyPlaceFilters(cached, opts, limit)

  const key = requireKey()
  const params = new URLSearchParams({ query, key })
  if (opts.near) {
    params.set('location', `${opts.near.lat},${opts.near.lng}`)
    params.set('radius', String(opts.radiusMeters ?? 16000))
  }
  if (opts.openNow) params.set('opennow', 'true')
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`
  const res = await fetchWithRetry(url)
  const data = (await res.json()) as {
    status: string
    results?: Array<{
      name?: string
      formatted_address?: string
      rating?: number
      user_ratings_total?: number
      price_level?: number
      opening_hours?: { open_now?: boolean }
      geometry?: { location?: { lat: number; lng: number } }
    }>
  }
  if (data.status === 'ZERO_RESULTS') {
    apiCache.set(cacheKey, [])
    return []
  }
  if (data.status !== 'OK') {
    throw new GeoError('geo_unavailable', `places status ${data.status}`)
  }
  const places: PlaceResult[] = (data.results ?? [])
    .map((r) => ({
      name: r.name ?? '',
      address: r.formatted_address ?? '',
      rating: typeof r.rating === 'number' ? r.rating : null,
      reviews: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : null,
      priceLevel: typeof r.price_level === 'number' ? r.price_level : null,
      openNow: r.opening_hours?.open_now ?? null,
      lat: r.geometry?.location?.lat ?? 0,
      lng: r.geometry?.location?.lng ?? 0,
    }))
    .filter((p) => p.name && p.lat !== 0 && p.lng !== 0)
  apiCache.set(cacheKey, places)
  return applyPlaceFilters(places, opts, limit)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/services/google-maps-places.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/google-maps.ts tests/services/google-maps-places.test.ts
git commit -m "feat(search): placesTextSearch on the Maps service"
```

---

### Task 2: `find_places` tool

**Files:**
- Create: `src/tools/find-places.ts`
- Test: `tests/tools/find-places.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools/find-places.test.ts`
Expected: FAIL — cannot find `../../src/tools/find-places.js`.

- [ ] **Step 3: Create the tool**

```ts
// src/tools/find-places.ts
// find_places: real-world place/food/spot search via Google Places text search.
// Output is JSON-stringified; errors surface as { error } objects, never thrown
// (matches the other geo tools). Reuses the geo budget (cheap Maps call) and
// resolveOrigin to anchor the search area, defaulting to USC campus.
//
// Header last reviewed: 2026-06-13
import { z } from 'zod'
import { placesTextSearch, GeoError } from '../services/google-maps.js'
import { checkGeoBudget } from '../services/geo-rate-limit.js'
import { resolveOrigin } from './places.js'
import { wrapTool } from './_wrap.js'

// USC University Park campus center — default anchor when no area is named.
const USC_CENTER = { lat: 34.0224, lng: -118.2851 }

type FindPlacesError =
  | { error: 'geo_budget_exceeded' }
  | { error: 'places_unavailable' }
  | { error: 'geo_disabled' }

const inputSchema = {
  query: z.string().describe('What to search for, e.g. "潮汕鱼生", "late night ramen", "boba near campus"'),
  near: z.string().optional().describe('Area or address to search near (default: USC). e.g. "San Gabriel", "K-town"'),
  open_now: z.boolean().optional().describe('Only return places open right now'),
  min_rating: z.number().optional().describe('Minimum Google rating, 0-5'),
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
}

export async function findPlacesHandler(input: {
  query: string
  near?: string
  open_now?: boolean
  min_rating?: number
  student_id?: string
}): Promise<string> {
  const query = String(input.query ?? '').trim()
  if (!query) return JSON.stringify({ places: [] })

  const studentId = String(input.student_id ?? '')
  if (!checkGeoBudget(studentId)) {
    return JSON.stringify({ error: 'geo_budget_exceeded' } satisfies FindPlacesError)
  }

  let near = USC_CENTER
  if (input.near) {
    const resolved = await resolveOrigin(input.near)
    // Unresolvable area → silently anchor at USC; a place search is still useful.
    if (!('error' in resolved)) near = resolved
  }

  try {
    const places = await placesTextSearch(query, {
      near,
      openNow: input.open_now,
      minRating: typeof input.min_rating === 'number' ? input.min_rating : undefined,
      limit: 5,
    })
    return JSON.stringify({ places })
  } catch (err) {
    if (err instanceof GeoError) {
      const code: FindPlacesError['error'] = err.code === 'geo_disabled' ? 'geo_disabled' : 'places_unavailable'
      return JSON.stringify({ error: code } satisfies FindPlacesError)
    }
    return JSON.stringify({ error: 'places_unavailable' } satisfies FindPlacesError)
  }
}

export const findPlacesTool = wrapTool({
  name: 'find_places',
  description:
    'Search the real world for places/food/spots by query (Google Places). Use this BEFORE saying you do not have something in your data — for restaurants, cafes, study spots, services, etc. Input: { query, near?, open_now?, min_rating? }. Returns { places: [{name, address, rating, reviews, priceLevel, openNow}] } (best-first, max 5) or an { error } object. Cite the place; never invent one not in the results.',
  schema: inputSchema,
  handler: findPlacesHandler,
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools/find-places.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/find-places.ts tests/tools/find-places.test.ts
git commit -m "feat(search): find_places tool over Google Places"
```

---

### Task 3: Register `find_places` and wire it into the two info sub-agents

**Files:**
- Modify: `src/tools/index.ts` (export + add to `ALL_TOOLS`)
- Modify: `src/agent/agents.config.ts` (whats-happening + know-things `tools`)
- Test: `tests/agent/find-places-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/find-places-wiring.test.ts
import { describe, it, expect } from 'vitest'
import { ALL_TOOLS } from '../../src/tools/index.js'
import { SUB_AGENTS } from '../../src/agent/agents.config.js'

describe('find_places wiring', () => {
  it('is registered in ALL_TOOLS', () => {
    expect((ALL_TOOLS as Record<string, unknown>).find_places).toBeDefined()
  })
  it('is listed by whats-happening and know-things, not find-people', () => {
    expect(SUB_AGENTS['whats-happening'].tools).toContain('find_places')
    expect(SUB_AGENTS['know-things'].tools).toContain('find_places')
    expect(SUB_AGENTS['find-people'].tools).not.toContain('find_places')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/agent/find-places-wiring.test.ts`
Expected: FAIL — `ALL_TOOLS.find_places` is undefined / `tools` lacks `find_places`.

- [ ] **Step 3: Register + wire**

In `src/tools/index.ts`: add an export alongside the others, an import alongside the others, and a registry entry inside `ALL_TOOLS`:

```ts
export { findPlacesTool } from './find-places.js'
// ...with the other imports near the top:
import { findPlacesTool } from './find-places.js'
// ...inside the `export const ALL_TOOLS = { … }` object, next to `travel_time`:
  find_places: findPlacesTool,
```

In `src/agent/agents.config.ts`, add `'find_places'` to the `tools` arrays of `'whats-happening'` (after `'travel_time'`) and `'know-things'` (after `'campus_knowledge'`):

```ts
// whats-happening.tools:
'travel_time',
'find_places',
// know-things.tools:
'campus_knowledge',
'find_places',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/find-places-wiring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts src/agent/agents.config.ts tests/agent/find-places-wiring.test.ts
git commit -m "feat(search): register find_places for whats-happening + know-things"
```

---

### Task 4: WebSearch daily budget

**Files:**
- Create: `src/services/web-search-budget.ts`
- Test: `tests/services/web-search-budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/web-search-budget.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { isWebSearchOverCap, recordWebSearchUse, _resetWebSearchBudget } from '../../src/services/web-search-budget.js'

beforeEach(() => { _resetWebSearchBudget(); delete process.env.WEB_SEARCH_DAILY_CAP })

describe('web search budget', () => {
  it('allows up to the cap, then reports over', () => {
    process.env.WEB_SEARCH_DAILY_CAP = '3'
    expect(isWebSearchOverCap('s1')).toBe(false)
    recordWebSearchUse('s1', 2)
    expect(isWebSearchOverCap('s1')).toBe(false)
    recordWebSearchUse('s1', 1)
    expect(isWebSearchOverCap('s1')).toBe(true)
  })
  it('defaults to 15/day', () => {
    recordWebSearchUse('s2', 14)
    expect(isWebSearchOverCap('s2')).toBe(false)
    recordWebSearchUse('s2', 1)
    expect(isWebSearchOverCap('s2')).toBe(true)
  })
  it('rolls over after 24h', () => {
    process.env.WEB_SEARCH_DAILY_CAP = '1'
    const t0 = 1_000_000
    recordWebSearchUse('s3', 1, t0)
    expect(isWebSearchOverCap('s3', t0)).toBe(true)
    expect(isWebSearchOverCap('s3', t0 + 25 * 60 * 60 * 1000)).toBe(false)
  })
  it('ignores non-positive counts', () => {
    recordWebSearchUse('s4', 0)
    expect(isWebSearchOverCap('s4')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/web-search-budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the budget**

```ts
// src/services/web-search-budget.ts
// Per-student daily budget for the (pricier) WebSearch server tool. Places
// search is cheap and shares the geo budget; web search is rationed here.
// Mirrors geo-rate-limit.ts but splits the read-only check from the record:
// WebSearch is a server tool we cannot intercept per call, so we read the
// actual web_search_requests count off the turn's usage and record it after.
//
// Default: 15 searches / 24h / student (env WEB_SEARCH_DAILY_CAP). In-process
// memory, fixed 24h buckets keyed on studentId.
//
// Header last reviewed: 2026-06-13
import { log } from '../observability/logger.js'

const WINDOW_MS = 24 * 60 * 60 * 1000

function maxPerDay(): number {
  const n = Number(process.env.WEB_SEARCH_DAILY_CAP)
  return Number.isFinite(n) && n > 0 ? n : 15
}

interface Bucket { windowStart: number; count: number }
const buckets = new Map<string, Bucket>()

function bucketFor(studentId: string, now: number): Bucket {
  const b = buckets.get(studentId)
  if (!b || now - b.windowStart >= WINDOW_MS) {
    const fresh = { windowStart: now, count: 0 }
    buckets.set(studentId, fresh)
    return fresh
  }
  return b
}

// Read-only: true when the student has already hit today's cap.
export function isWebSearchOverCap(studentId: string, now: number = Date.now()): boolean {
  return bucketFor(studentId, now).count >= maxPerDay()
}

// Record actual web searches performed this turn (from usage.server_tool_use).
export function recordWebSearchUse(studentId: string, count: number, now: number = Date.now()): void {
  if (count <= 0) return
  const b = bucketFor(studentId, now)
  b.count += count
  if (b.count >= maxPerDay()) {
    log('warn', 'web_search_budget_exhausted', { studentId, count: b.count })
  }
}

// Test-only helper. Do not call from production code.
export function _resetWebSearchBudget(): void { buckets.clear() }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/services/web-search-budget.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/web-search-budget.ts tests/services/web-search-budget.test.ts
git commit -m "feat(search): per-student daily WebSearch budget"
```

---

### Task 5: Trusted-domain allowlist

**Files:**
- Create: `src/services/web-search-config.ts`
- Test: `tests/services/web-search-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/web-search-config.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { trustedDomains } from '../../src/services/web-search-config.js'

beforeEach(() => { delete process.env.WEB_SEARCH_ALLOWED_DOMAINS })

describe('trustedDomains', () => {
  it('returns the curated default list', () => {
    expect(trustedDomains()).toContain('xiaohongshu.com')
    expect(trustedDomains()).toContain('usc.edu')
  })
  it('parses a comma-separated env override (trimmed)', () => {
    process.env.WEB_SEARCH_ALLOWED_DOMAINS = 'a.com, b.com ,c.com'
    expect(trustedDomains()).toEqual(['a.com', 'b.com', 'c.com'])
  })
  it('falls back to default on a blank override', () => {
    process.env.WEB_SEARCH_ALLOWED_DOMAINS = '   '
    expect(trustedDomains()).toContain('reddit.com')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/services/web-search-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the config**

```ts
// src/services/web-search-config.ts
// Trusted-source allowlist for WebSearch. Restricts results to quality sources
// (cuts SEO spam / misinformation, reinforces the never-invent rule). The list
// is injected into the info sub-agents' prompts as the allowed_domains they
// must pass to WebSearch (allowed_domains is model-provided per call). Retune
// in one place via WEB_SEARCH_ALLOWED_DOMAINS (comma-separated).
//
// Header last reviewed: 2026-06-13
const DEFAULT_TRUSTED_DOMAINS = [
  'usc.edu',
  'reddit.com',
  'yelp.com',
  'tripadvisor.com',
  'xiaohongshu.com',
  'dianping.com',
  'timeout.com',
  'lacity.gov',
  'metro.net',
]

export function trustedDomains(): string[] {
  const raw = process.env.WEB_SEARCH_ALLOWED_DOMAINS
  if (!raw) return DEFAULT_TRUSTED_DOMAINS
  const parsed = raw.split(',').map((d) => d.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : DEFAULT_TRUSTED_DOMAINS
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/services/web-search-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/web-search-config.ts tests/services/web-search-config.test.ts
git commit -m "feat(search): trusted-domain allowlist for WebSearch"
```

---

### Task 6: Enable `WebSearch` in the orchestrator (budget gate + trusted-domain guidance)

**Files:**
- Modify: `src/agent/orchestrator.ts`
- Test: `tests/agent/orchestrator.test.ts` (extend)

Context: `buildAgentsConfig(profile)` currently maps each `SUB_AGENTS` entry, appending the user-profile block and (when `isProfileEmpty`) the `ONBOARDING_NUDGE`, with `tools: def.tools.map(nsTool)`. We add a `webAllowed` param, append `'WebSearch'` (un-namespaced, an SDK built-in) + a dynamic web-search guidance block for whats-happening + know-things when `webAllowed`, and **export** the function for testing. `runOrchestrator` computes `webAllowed` from the budget, threads it in, adds `'WebSearch'` to `allowedTools`, and records actual usage from the result message.

- [ ] **Step 1: Write the failing test (extend `tests/agent/orchestrator.test.ts`)**

```ts
// add near the top imports:
import { buildAgentsConfig } from '../../src/agent/orchestrator.js'

// add a new describe block:
describe('web search wiring', () => {
  it('gives whats-happening + know-things WebSearch + find_places when allowed; find-people gets neither', () => {
    const cfg = buildAgentsConfig(null, true)
    expect(cfg['whats-happening'].tools).toContain('WebSearch')
    expect(cfg['know-things'].tools).toContain('WebSearch')
    expect(cfg['whats-happening'].tools).toContain('mcp__george__find_places')
    expect(cfg['know-things'].tools).toContain('mcp__george__find_places')
    expect(cfg['find-people'].tools).not.toContain('WebSearch')
    expect(cfg['find-people'].tools).not.toContain('mcp__george__find_places')
  })
  it('omits WebSearch (and its guidance) when over the daily cap', () => {
    const cfg = buildAgentsConfig(null, false)
    expect(cfg['whats-happening'].tools).not.toContain('WebSearch')
    expect(cfg['whats-happening'].prompt).not.toMatch(/allowed_domains/)
  })
  it('injects trusted-domain guidance into the info agents when web is allowed', () => {
    const cfg = buildAgentsConfig(null, true)
    expect(cfg['whats-happening'].prompt).toMatch(/allowed_domains/)
    expect(cfg['whats-happening'].prompt).toMatch(/xiaohongshu\.com/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: FAIL — `buildAgentsConfig` is not exported / signature mismatch.

- [ ] **Step 3: Implement the orchestrator changes**

3a. Add imports near the other `src/services` imports in `src/agent/orchestrator.ts`:

```ts
import { isWebSearchOverCap, recordWebSearchUse } from '../services/web-search-budget.js';
import { trustedDomains } from '../services/web-search-config.js';
```

3b. Add a guidance builder above `buildAgentsConfig` (near `ONBOARDING_NUDGE`):

```ts
// Dynamic WebSearch guidance — injected into the info sub-agents only while the
// user is under their daily web-search cap. Carries the trusted-domain list the
// agent must pass as allowed_domains (allowed_domains is model-provided per call).
function webSearchGuidance(): string {
  return [
    '# WEB SEARCH',
    'You have a WebSearch tool for open-web facts you do not already have. It is',
    'rationed — use it only after find_places and your own data come up empty, and',
    'not for things you already know.',
    `When you call WebSearch, pass allowed_domains: ${JSON.stringify(trustedDomains())}`,
    'so results come from trusted sources. Cite the source in your reply; never state',
    'a fact, name, address, or price that is not in the results.',
  ].join('\n');
}
```

3c. Change `buildAgentsConfig`'s signature and body:

```ts
export function buildAgentsConfig(
  profile?: Profile | null,
  webAllowed: boolean = false,
): Record<string, { description: string; prompt: string; tools: string[] }> {
  const userProfileBlock = buildUserProfileBlock(profile);
  const nudge = isProfileEmpty(profile) ? ONBOARDING_NUDGE : '';
  const config: Record<string, { description: string; prompt: string; tools: string[] }> = {};
  for (const [name, def] of Object.entries(SUB_AGENTS)) {
    const wantsWeb = name === 'whats-happening' || name === 'know-things';
    const webBlock = wantsWeb && webAllowed ? webSearchGuidance() : '';
    const extras = [userProfileBlock, nudge, webBlock].filter(Boolean).join('\n\n');
    config[name] = {
      description: def.description,
      prompt: extras ? `${def.prompt}\n\n${extras}` : def.prompt,
      tools: [
        ...def.tools.map(nsTool),
        ...(wantsWeb && webAllowed ? ['WebSearch'] : []),
      ],
    };
  }
  return config;
}
```

> NOTE: this replaces the current `function buildAgentsConfig(profile?: Profile | null)`. Keep the existing `userProfileBlock`/`nudge` lines — only the signature, the `webBlock`, and the `tools` array change.

3d. In `runOrchestrator`, compute `webAllowed`, thread it in, allow the tool, and record usage. Replace the relevant lines:

```ts
const profile = args.profileStore ? await args.profileStore.loadProfile(args.userId) : null;
const webAllowed = !isWebSearchOverCap(args.userId);

const systemPrompt = buildOrchestratorPrompt(profile);
const agentsConfig = buildAgentsConfig(profile, webAllowed);
```

In the `query({ … options })`, change `allowedTools` to include `'WebSearch'`:

```ts
allowedTools: ['Task', 'Agent', 'WebSearch', ...Object.keys(ALL_TOOLS).map(nsTool)],
```

Replace the `for await` body to record web-search usage off the result message:

```ts
  })) {
    const m = message as {
      type?: string;
      usage?: { server_tool_use?: { web_search_requests?: number } };
    };
    if (m.type === 'result') {
      const n = m.usage?.server_tool_use?.web_search_requests ?? 0;
      if (n > 0) recordWebSearchUse(args.userId, n);
    }
    yield message as { type: string; text?: string };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: PASS (existing tests + 3 new web-wiring tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.ts tests/agent/orchestrator.test.ts
git commit -m "feat(search): enable WebSearch for info agents, budget-gated + trusted-domain biased"
```

---

### Task 7: Prompt routing — "look before you say 没有数据"

**Files:**
- Modify: `prompts/master.md`, `prompts/whats-happening.md`, `prompts/know-things.md`

No unit test (prose). The behavior is verified by the smoke test in Task 8; this step adds the routing instruction that makes george reach for the tools.

- [ ] **Step 1: Add to `prompts/master.md`** (append a short block under the existing anti-fabrication guidance):

```markdown
## Look it up before you say you don't know

Before you reach for 戳到知识盲区了 / 没有数据 / "I don't have that", try your tools.
For places, food, restaurants, cafes, study spots, services → `find_places`. For
open-web facts you genuinely don't have → web search (it's rationed; don't burn it
on things you already know). Only say you don't know **after** the tools come back
empty — and when they do, give a concrete self-serve path (e.g. 大众点评 搜 X /
小红书 搜 Y). Never invent a name, address, or price; cite what the tools return.
```

- [ ] **Step 2: Add one line to `prompts/whats-happening.md`** (near the places/food guidance):

```markdown
- **Don't dead-end on "no data".** If the events/places DB misses, call `find_places`
  for real spots (curate to 2-3 best, lead with rating + the trade-off, code-switch).
  Only after it's empty do you fall back to a self-serve pointer.
```

- [ ] **Step 3: Add one line to `prompts/know-things.md`** (near the knowledge-search guidance):

```markdown
- **Search before you refuse.** For an off-campus place/service use `find_places`;
  for an open-web fact you don't have, web search (rationed, trusted sources only).
  Cite results; never fabricate. Cap recommendations at 2-3.
```

- [ ] **Step 4: Verify the edits landed**

Run: `grep -l "Look it up before" prompts/master.md && grep -l "find_places" prompts/whats-happening.md prompts/know-things.md`
Expected: all three paths printed.

- [ ] **Step 5: Commit**

```bash
git add prompts/master.md prompts/whats-happening.md prompts/know-things.md
git commit -m "feat(search): prompt routing — look up via find_places/web before saying no"
```

---

### Task 8: Integration verify

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npx tsc`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all pass (existing + the new search tests).

- [ ] **Step 3: Manual smoke (optional, needs a live `GOOGLE_MAPS_API_KEY`)**

Run george locally (`npm run dev` with the key set) and POST a chat:
```bash
curl -s localhost:3001/chat -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"dev","platform":"imessage","text":"find me a 潮汕鱼生 near san gabriel"}'
```
Expected: george returns 2-3 real places with ratings (not "no data"), citing them; the log shows a `find_places` tool call.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/realworld-search
gh pr create --base main --title "feat(search): real-world search (Phase 1 — find_places + WebSearch)" --body-file <(echo "Implements docs/superpowers/specs/2026-06-13-realworld-search-design.md. find_places (Google Places) + SDK WebSearch for What's Happening + Know Things, tiered cost gating (geo budget for Places, ~15/day for WebSearch), trusted-domain bias, prompt routing, anti-fabrication preserved. Phase 2 (小红书/大众点评 ingestion) is a separate spec.")
```

Then deploy by merging to `main` and triggering the Railway deploy of the merge commit (`serviceInstanceDeployV2`, since auto-deploy-on-push doesn't fire) — same flow as the onboarding PRs.

---

## Self-review

**Spec coverage:** §4.1 placesTextSearch → Task 1. §4.2 find_places + registration → Tasks 2-3. §4.3 WebSearch enablement + trusted domains → Tasks 5-6. §4.4 web-search budget → Task 4. §4.5 prompt routing → Task 7. §6 anti-fabrication/voice → Tasks 2/6/7 (tool descriptions + guidance + prompts). §7 error handling → Task 2 ({error} mapping). §8 testing → every task is TDD. ✅ all covered.

**Placeholder scan:** no TBD/TODO/"handle edge cases" — every step has complete code and exact commands. ✅

**Type consistency:** `PlaceResult` (Task 1) is consumed by `placesTextSearch` (Task 1) and produced through `find_places` (Task 2). `findPlacesHandler` input shape matches the zod `inputSchema`. `buildAgentsConfig(profile, webAllowed)` signature matches its call site in `runOrchestrator` (Task 6) and the tests (Task 6). `isWebSearchOverCap`/`recordWebSearchUse`/`_resetWebSearchBudget` names match between Task 4 impl, its tests, and the Task 6 import. `trustedDomains()` matches between Task 5 and Task 6. ✅
