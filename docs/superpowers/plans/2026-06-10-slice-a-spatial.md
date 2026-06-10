# Slice A — Spatial Reasoning Layer Implementation Plan

**Goal:** Safety-aware location answers. "Is Dino's safe to walk to at 11pm?",
"which dorm is closest to Annenberg?", "am I inside the DPS zone at 2am?" —
answered with real math over verified coordinates, never invented.

**Roadmap reference:** `2026-06-07-roadmap-v2-reality-aware.md`, Slice A.
Approved sequencing: A runs parallel with Slice B (shipped, PR #5).

## Deviation from the roadmap (intentional, CTO call)

The roadmap specified PostGIS tables (`spatial_locations`, `dps_zones`,
`transit_stops`), migrations 005-007, and an OSM/Overpass ingestion script.
v1 ships none of that:

- `src/services/usc-aliases.ts` already holds 36 hand-verified coordinates
  covering every location students actually name. That IS the v1 location
  table.
- ~20 DPS zone polygons fit in one versioned GeoJSON checked into the repo
  (`data/dps-zones-v1.geojson`), loaded into memory at first use. Point-in-
  polygon over 20 polygons is microseconds; PostGIS earns nothing here.
- No migration means no bia-admin coordination and no prod schema risk.

Upgrade path: if the location count passes ~500 or we need polygon joins in
SQL, revisit PostGIS with the original 005-007 design. The service interface
(`spatial.ts`) hides the storage, so the swap is internal.

## Anti-fabrication rule for zone data (hard requirement)

DPS zone polygons make SAFETY claims. The repo must never contain polygons I
(or any agent) guessed. Therefore:

- `data/dps-zones-v1.geojson` is NOT in this PR. Bobby hand-compiles it from
  the official DPS patrol map (dps.usc.edu) — the roadmap's budgeted half-day
  task. Format spec below.
- Until that file exists, `dps_zone_check` and `safe_route` return
  `zone_data_unavailable` and george falls back to the documented static
  facts (DPS share-Lyft hours 20:00–03:00) plus the knowledge-boundary voice.
  No zone claim is ever made without the file.
- Tests use clearly-fake fixture polygons under `tests/fixtures/`.

## GeoJSON contract for `data/dps-zones-v1.geojson`

FeatureCollection of Polygon features. Per-feature `properties`:
`{ "name": "Zone 2", "risk": "green" | "yellow" | "red" }`.
Coordinates in [lng, lat] order (GeoJSON standard). First+last ring point
must close the ring.

## Tasks

- [x] `src/services/spatial.ts` — haversine distance, walking-minutes
      estimate (4.8 km/h × 1.3 route factor), ray-cast point-in-polygon,
      GeoJSON zone loader (cached, missing-file safe), LA-timezone
      share-Lyft-hours check (20:00–03:00 per AGENT.md safety circle).
- [x] `src/tools/dps-zone-check.ts` — `dps_zone_check`: which zone (if any)
      contains a named place; explicit `zone_data_unavailable` fallback.
- [x] `src/tools/distance-compare.ts` — `distance_compare`: rank N candidate
      places by distance from an origin. Alias-table hits cost zero Google
      calls; unknown places fall back to geocoding under the existing
      geo budget.
- [x] `src/tools/safe-route.ts` — `safe_route`: walkability + zone + Lyft-
      hours verdict for "is X safe to walk to at <time>". Never says
      "safe"/"unsafe" itself — returns facts; the persona phrases advice.
- [x] Export `resolveOrigin` from `places.ts` for reuse (no behavior change).
- [x] Wire tools into `src/tools/index.ts` + `agents.config.ts`
      (whats-happening gets all 3; know-things gets `dps_zone_check`).
- [x] Tests: `tests/services/spatial.test.ts`,
      `tests/tools/dps-zone-check.test.ts`, `tests/tools/safe-route.test.ts`,
      `tests/tools/distance-compare.test.ts` with fixture zones.
- [ ] Bobby: hand-compile `data/dps-zones-v1.geojson` from the DPS map
      (half-day, out of this PR).
- [ ] Slice F: add the 10 spatial golden-set questions once zone data lands.

## Out of scope

- PostGIS migrations + OSM ingestion (see deviation note).
- Transit stops / Metro awareness — needs the transit_stops dataset; defer
  until a real student asks a transit question the travel_time tool can't
  already answer.
- Extending `places.ts` find_places_near (still Phase 2 TODO there).
