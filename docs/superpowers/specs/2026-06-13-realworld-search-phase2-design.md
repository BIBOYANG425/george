# Real-world Search — Phase 2: Yelp live source

> Phase 2 of the real-world search work. Phase 1 (`2026-06-13-realworld-search-design.md`)
> shipped `find_places` over Google Places + budget-gated WebSearch. This phase adds
> **Yelp Places API** (the REST API formerly "Yelp Fusion") as a second live source,
> merged into `find_places` so niche/ethnic spots Google covers thinly (the canonical
> `潮汕鱼生` gap) get a second set of eyes.

**Status:** approved 2026-06-13. Supersedes §10 ("Phase 2 preview") of the Phase 1 spec.

**Goal:** `find_places` returns a merged, de-duplicated, source-cited result set drawn
from Google Places **and** Yelp, ranked so that places both sources agree on float to
the top, without ever fabricating a place.

---

## 1. Scope

**In scope**

- A thin `src/services/yelp.ts` client over Yelp Places API `GET /v3/businesses/search`.
- Merge + de-dup of Google and Yelp candidates inside `find_places`, with source citation.
- Graceful degradation: if Yelp is unconfigured or fails, `find_places` runs on Google
  alone (and vice-versa); the call only errors when **both** sources fail.
- `YELP_API_KEY` env wiring + `.env.example` docs.
- Tests for the Yelp client and the merge.

**Explicitly out of scope (deferred warm-store)**

- Background ingestion of 小红书 (RedNote), 大众点评 (Dianping), or Beli into a
  `local_spots` table. All three are reverse-engineered / unofficial (no public API)
  and gated on China-proxy or app-session infra we'd have to own and maintain. Documented
  here as future work; **not built**. Revisit only when there is appetite for that
  operational surface. The `find_places` merge below is written so a third "warm-store"
  source can be added to the same merge step later without reshaping it.

## 2. Architecture

`find_places` becomes a 2-source live merge (read order is parallel, not sequential —
both fire at once via `Promise.allSettled`):

```
find_places(query, near?, open_now?, min_rating?)
   │  checkGeoBudget (unchanged — one find_places call = one budget unit)
   │  resolveOrigin(near) → coords (default USC)
   ├─ Google placesTextSearch(query, {near, openNow, minRating})   → PlaceResult[] (source:'google')
   └─ Yelp    yelpBusinessSearch(query, {near, openNow})           → PlaceResult[] (source:'yelp')
            │  Promise.allSettled — one failing source never sinks the other
            ▼
   mergePlaces([google, yelp], {minRating, limit:5})
            │  de-dup by normalized-name + proximity (~50m)
            │  rank: source-agreement desc → rating desc → reviews desc
            ▼
   { places: [{name,address,rating,reviews,priceLevel,openNow,url,sources}] }
```

## 3. `src/services/yelp.ts`

Mirrors `google-maps.ts`: one thin client, an LRU cache (1h, shared shape), a
timeout+single-retry fetch, and a typed error so the caller can map to a tool error.

```ts
export class YelpError extends Error {
  constructor(public code: 'yelp_disabled' | 'yelp_unavailable', message: string) { super(message) }
}

export interface YelpSearchOpts {
  near?: { lat: number; lng: number }
  radiusMeters?: number   // capped at 40000 (Yelp max)
  openNow?: boolean
  limit?: number          // default 8, capped at 50 (Yelp max)
}

// Returns PlaceResult[] (the google-maps.ts shape) with source:'yelp', url set.
export async function yelpBusinessSearch(term: string, opts?: YelpSearchOpts): Promise<PlaceResult[]>
```

Request: `GET https://api.yelp.com/v3/businesses/search?term=&latitude=&longitude=&radius=&open_now=&limit=`,
header `Authorization: Bearer ${YELP_API_KEY}`.

Field mapping (Yelp business → `PlaceResult`):

| PlaceResult | Yelp business field | Notes |
|---|---|---|
| `name` | `name` | drop entries with empty name |
| `address` | `location.display_address` | `join(', ')` |
| `rating` | `rating` | float or null |
| `reviews` | `review_count` | int or null |
| `priceLevel` | `price` | `"$".."$$$$"` → length `1..4`; absent → null |
| `openNow` | — | `true` only when we passed `open_now=true` (all returned are open); else `null`. **Never** use `is_closed` (that flag means *permanently* closed). |
| `lat` / `lng` | `coordinates.latitude/longitude` | drop entries missing coords |
| `url` | `url` | the Yelp business page (for citation) |
| `source` | — | literal `'yelp'` |

Errors: missing key → `YelpError('yelp_disabled')`; non-OK HTTP (incl. 429/403/5xx
after one retry) → `YelpError('yelp_unavailable')`. The key check lives inside the async
function so it surfaces as a rejected promise (caught by `allSettled` in the caller).

## 4. `PlaceResult` shape (in `src/services/google-maps.ts`)

Add two optional fields so both sources describe themselves; additive, existing callers
unaffected:

```ts
export interface PlaceResult {
  name: string; address: string
  rating: number | null; reviews: number | null
  priceLevel: number | null; openNow: boolean | null
  lat: number; lng: number
  source?: 'google' | 'yelp'   // NEW
  url?: string | null          // NEW
}
```

`placesTextSearch` sets `source:'google'`, `url:null` on each mapped result.

## 5. Merge + de-dup (in `src/tools/find-places.ts`)

Exported pure helper `mergePlaces(lists: PlaceResult[][], opts)` so it unit-tests without
any network mock.

- **Same-spot test:** two candidates are the same place when they are within ~50m
  (haversine) **and** their normalized names are equal or one contains the other.
  `normName = lowercase → NFKD strip diacritics → keep [a-z0-9] + CJK only`.
- **Collapse:** first occurrence wins as the primary record; a later match adds its
  `source` to `sources: string[]` and back-fills any `null` field (rating, reviews,
  priceLevel, url) and `openNow ||=`.
- **Rank:** `sources.length` desc (agreement first) → `rating` desc → `reviews` desc.
- **Filter/limit:** apply `minRating` across the merged set, then `slice(limit)`.

Output per place gains `url` and `sources` (e.g. `["google","yelp"]`). The tool
description instructs George to cite the place and may mention which source(s) back it;
no place outside the results may be invented (unchanged anti-fabrication rule).

## 6. Error handling in `find_places`

- `checkGeoBudget` short-circuit and empty-query guard: unchanged.
- Both sources fire under `allSettled`. Collect fulfilled results; merge.
- If the merged set is non-empty → return it (a Yelp-only or Google-only result is fine).
- If **both** rejected (or both empty): map to the existing error codes. A Google
  `GeoError('geo_disabled')` → `geo_disabled`; anything else (Google `geo_unavailable`,
  Yelp `yelp_*`, both empty) → `places_unavailable`. No new error codes.

## 7. Cost & ops

- Yelp Places API is account-gated and may require a billing method (limited free trial
  tier). The code path is identical regardless of plan. Until `YELP_API_KEY` is set,
  `yelpBusinessSearch` rejects `yelp_disabled`, Yelp is silently skipped, and
  `find_places` runs Google-only. No build/runtime dependency on the key.
- Per-call cost is bounded by the existing `checkGeoBudget` gate (one unit per
  `find_places` call covers both sources) and the 1h LRU cache in each client.
- **Ops prereq (does not block this build):** provision `YELP_API_KEY` and set it on
  Railway. Add to `.env.example` (`[agent]`, optional).

## 8. Testing

- `tests/services/yelp.test.ts` — `vi.stubGlobal('fetch')`: maps businesses → PlaceResult,
  price `$$`→2, `open_now=true`→openNow true, missing key → `yelp_disabled`, non-OK →
  `yelp_unavailable`, ZERO/empty → `[]`, cache hit avoids a second fetch.
- `tests/tools/find-places.test.ts` (extend) — Google+Yelp same spot collapses to one with
  `sources:["google","yelp"]`; distinct spots both kept; agreement ranks first; Yelp-only
  when Google throws; Google-only when Yelp throws (existing behavior, no `YELP_API_KEY`);
  both-fail → `places_unavailable`; `min_rating` filters the merged set.
- `tests/tools/find-places.test.ts` existing cases stay green (Yelp un-keyed in test env
  rejects `yelp_disabled` → caught → Google-only path).

## 9. Files

- Create: `src/services/yelp.ts`, `tests/services/yelp.test.ts`
- Modify: `src/services/google-maps.ts` (PlaceResult + `source`/`url` on Google results),
  `src/tools/find-places.ts` (merge, `mergePlaces`, Yelp call, tool description),
  `tests/tools/find-places.test.ts` (merge cases), `.env.example` (`YELP_API_KEY`)
