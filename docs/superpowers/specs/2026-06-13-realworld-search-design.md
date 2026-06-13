# Real-World Search for george — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming) → ready for implementation plan
**Repo:** george (`~/Code/george`)

**Goal:** Give george the ability to look things up in the real world (places/food via Google Places, anything else via web search) so it answers "find me a 潮汕鱼生 in LA" with real, cited results instead of "我手头确实没有数据."

**Architecture:** Two additive tools wired into the existing 3-subagent setup. A `find_places` tool over a new Google Places text-search method on the existing Maps service, plus the Agent SDK's built-in `WebSearch` server tool. Both are cost-gated (tiered). No new infrastructure — reuses `wrapTool`, the geo budget, and the existing slow-tool "still digging" nudge.

**Tech stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (built-in `WebSearch`), Google Places Text Search API, zod, existing `src/tools/_wrap.ts` + `src/services/google-maps.ts` patterns.

---

## 1. Problem & context

Observed in production (number `+16282649335`): a student asked george to find a 潮汕鱼生 (Chaoshan raw-fish) restaurant. george correctly **refused to fabricate** a name ("我硬报店名就是编的,你跑空更亏" — the anti-fabrication guardrail working) but had **no way to look it up** — it is capped at the internal USC-food DB, so its only honest answer was "I don't have that." Founder framing: "缺了个 query()." Friend framing: integrating 小红书/大众点评 would be "绝杀."

The honesty is correct and must be preserved. The gap is **search capability**: george needs to try real sources before saying it doesn't know.

### What already exists (build on, don't rebuild)
- **Maps service** `src/services/google-maps.ts`: `geocode()`, `distanceMatrix()`, `GeoError`. Reads `process.env.GOOGLE_MAPS_API_KEY`, throws `GeoError('geo_disabled', …)` when unset. Hits `maps.googleapis.com/maps/api/*`.
- **Geo budget** `src/services/geo-rate-limit.ts`: `checkGeoBudget(studentId, now?) → boolean`, `_resetBudgets()` (test hook).
- **Tool convention**: `wrapTool` (`src/tools/_wrap.ts`), zod input schema, output **JSON-stringified**, errors surfaced as `{ error: … }` objects **never thrown**. Registered in `src/tools/index.ts`; sub-agent tool lists in `src/agent/agents.config.ts`.
- **`places.ts`** (travel_time) header already names `find_places_near` as the "Phase 2, TODO" — this spec delivers it (named `find_places`).
- **SDK built-in `WebSearch`**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` exposes `WebSearch` with `WebSearchInput { allowed_domains?: string[]; … }` and tracks `web_search_requests`. Enabled by adding `'WebSearch'` to the `query()` `tools` allowlist.
- **Slow-tool UX**: the `STILL_THINKING` nudge in `src/adapters/spectrum.ts` already covers multi-second turns.

---

## 2. Scope

**In (Phase 1 — this spec):** live `find_places` (Google Places) + live `WebSearch` (SDK built-in), tiered cost gating, prompt routing, anti-fabrication + voice rules, tests.

**Out (Phase 2 — separate spec):** background 小红书/大众点评 ingestion via Apify into a warm local store (mirrors the Instagram event scraper). Slow/brittle/login-walled — not a live-turn path. Noted in §10.

---

## 3. Architecture & placement

| Capability | Tool | Owner sub-agent(s) |
|---|---|---|
| Find real places/food/spots by query | `find_places` (custom MCP tool) | **What's Happening** + **Know Things** |
| Search the open web for facts/info | `WebSearch` (SDK server tool) | **What's Happening** + **Know Things** |

- `find_places` is a normal george tool listed by **both** What's Happening (food/nightlife/spots) and Know Things (e.g. quiet off-campus study spots, services, libraries).
- `WebSearch` is enabled at the `query()` level via the `tools` allowlist (`src/agent/orchestrator.ts` `buildOrchestratorToolNames()` / sub-agent tool lists in `agents.config.ts`). **Find People** does not get either tool.

---

## 4. Components

### 4.1 `placesTextSearch` — new method in `src/services/google-maps.ts`

```ts
export interface PlaceResult {
  name: string;
  address: string;        // formatted_address
  rating: number | null;  // 0–5, null if unrated
  reviews: number | null; // user_ratings_total
  priceLevel: number | null; // 0–4, null if unknown
  openNow: boolean | null;
  lat: number;
  lng: number;
}

// Google Places Text Search. Returns up to `limit` results, best-first.
// Throws GeoError('geo_disabled') when GOOGLE_MAPS_API_KEY is unset (same as
// geocode/distanceMatrix). Throws GeoError('geo_upstream') on a non-OK status.
export async function placesTextSearch(
  query: string,
  opts?: { near?: { lat: number; lng: number }; radiusMeters?: number; openNow?: boolean; minRating?: number; limit?: number },
): Promise<PlaceResult[]>
```

- Endpoint: `https://maps.googleapis.com/maps/api/place/textsearch/json?query=…&key=…` (+ `location`/`radius`/`opennow` when provided). `minRating`/`limit` applied client-side after sort.
- `near` resolves from a location string via the existing `geocode()` when the tool passes one; defaults to USC center when omitted (reuse the alias/USC-center constant already used by `places.ts`/`distance-compare`).

### 4.2 `find_places` tool — new file `src/tools/find-places.ts`

```ts
// zod input
{ query: string; near?: string; openNow?: boolean; minRating?: number }
```

- Resolves `near` (string → coords) via `resolveOrigin`/`geocode` (already exported from `places.ts`/maps service); default USC.
- **Cost gate:** calls `checkGeoBudget(studentId)` first (Places counts against the existing geo budget — it is cheap and shares the geo cost pool). Over budget → `{ error: 'geo_budget_exceeded' }`.
- Calls `placesTextSearch`, caps to **5 candidates**, returns JSON-stringified `{ places: PlaceResult[] }`. Zero results → `{ places: [] }` (not an error — george gives the self-serve pointer).
- Missing key / upstream error → `{ error: 'places_unavailable' }`. Never throws (matches `wrapTool` contract).
- Register in `src/tools/index.ts` (`find_places: findPlacesTool`) and add `'find_places'` to **both** the What's Happening and Know Things tool lists in `src/agent/agents.config.ts`.

### 4.3 `WebSearch` enablement — `src/agent/orchestrator.ts` + `agents.config.ts`

- Add `'WebSearch'` to the allowlist returned for the orchestrator and for the What's Happening / Know Things sub-agents (NOT Find People).
- **Bias toward trusted sources:** pass `allowed_domains = TRUSTED_DOMAINS` so web results come only from quality sources — cuts SEO-spam/misinformation and reinforces anti-fabrication. Starter set (tunable via `WEB_SEARCH_ALLOWED_DOMAINS` env, comma-separated; lives in a small `src/services/web-search-config.ts` so it is one edit to retune): `usc.edu`, `reddit.com`, `yelp.com`, `tripadvisor.com`, `xiaohongshu.com`, `dianping.com`, `timeout.com`, plus authoritative LA city / Metro / `.gov` sites. The list is intentionally generous (per "looser" posture) but quality-gated — broad enough not to starve results, curated enough to keep george citing sources worth trusting.
- **Per-turn ceiling:** keep web searches to ≤2 per turn via prompt instruction (the SDK reports `web_search_requests` but does not expose a hard `max_uses` in `WebSearchInput`; we cap behaviorally + via the daily counter below).

### 4.4 Web-search daily cap — new `src/services/web-search-budget.ts`

Mirrors `geo-rate-limit.ts` exactly:

```ts
export function checkWebSearchBudget(studentId: string, now?: number): boolean; // false when over cap
export function _resetWebSearchBudget(): void; // test hook
```

- Default cap: **15 web searches / user / rolling 24h** (looser posture; in-memory LRU keyed by `studentId`; same structure as the geo budget). Configurable via `WEB_SEARCH_DAILY_CAP` env (default 15).
- Enforcement point: because `WebSearch` is a server tool george invokes autonomously, the cap is checked in the **orchestrator turn setup** — when a user is over cap, `'WebSearch'` is **omitted** from that turn's allowlist and a system line tells george "web search is rationed today; use find_places / give the self-serve pointer." `find_places` (cheap) stays available regardless.

### 4.5 Prompt routing (tiered)

Add a short block to `prompts/master.md` (shared) and reinforce in `prompts/whats-happening.md` + `prompts/know-things.md`:

> Before you say 戳到知识盲区了 / 没有数据, **try to look it up**. For places, food, spots, services → call `find_places`. For open-web facts you don't have → use web search (rationed; don't burn it on things you already know). Only say you don't know **after** the tools come back empty. When they do come back empty, give the student a concrete self-serve path (e.g. 大众点评 搜 X / 小红书 搜 Y) — never invent a name, address, or price.

---

## 5. Data flow

```
user: "find me a 潮汕鱼生 in LA"
  → orchestrator → What's Happening sub-agent
    → find_places({ query:"潮汕鱼生", near:"San Gabriel" })
       checkGeoBudget(studentId)  →  placesTextSearch  →  {places:[…5…]}
    → george curates top 2–3 in voice, cites rating/source, adds drive option (travel_time)
  (if find_places empty AND open-web needed AND under web cap)
    → WebSearch("洛杉矶 潮汕鱼生 推荐")  →  cited results  →  george summarizes, links source
  (if over web cap OR still nothing)
    → honest "真没找到" + self-serve pointer (大众点评 / 小红书 search terms)
```

---

## 6. Anti-fabrication & voice (preserved + strengthened)

- Tools return **source-attributed** data only (Google place names/addresses; web results carry URLs/citations). The prompt forbids stating any name/address/price not present in tool output.
- **Curate, cap 2–3** (same discipline as the anti-zoom-mixer events rule). Lead with the specific tell (rating, the trade-off), code-switch per the voice fingerprint. Never dump the raw 5-item list.
- Empty results → honest + self-serve pointer (the exact good behavior from the screenshot, now *after* actually searching).

---

## 7. Error handling & latency

- All tool failures return `{ error: … }`, never throw (matches existing tools).
- Missing `GOOGLE_MAPS_API_KEY` → `places_unavailable` → george degrades to the self-serve pointer.
- Latency ~1–3s is covered by the existing `STILL_THINKING` nudge in `spectrum.ts`; no new UX needed.
- Over-budget is a normal (non-error) path: `find_places` returns `geo_budget_exceeded`; `WebSearch` is simply absent that turn.

---

## 8. Testing

- `placesTextSearch`: mock `fetch` → parse OK/ZERO_RESULTS/non-OK; `minRating`/`limit`/`openNow` filtering; `geo_disabled` when key unset.
- `find_places` tool: zod input validation; budget-exceeded short-circuits before the HTTP call; empty results → `{places:[]}`; upstream error → `{error:'places_unavailable'}`; cap = 5; output is JSON-stringified.
- `checkWebSearchBudget`: allows N then blocks; rolls over after 24h; `_resetWebSearchBudget` clears (test hook).
- Orchestrator wiring: `'find_places'` AND `'WebSearch'` present for **both** What's Happening and Know Things, **absent** for Find People; `'WebSearch'` omitted from the turn when the user is over the web cap; `allowed_domains` resolves from `TRUSTED_DOMAINS` / `WEB_SEARCH_ALLOWED_DOMAINS`.

---

## 9. Decision log

- **Both phases, phased build** — live search first (fixes the screenshot today), 小红书/大众点评 background later (it is a slow-scraper subsystem, wrong tool for a live turn).
- **SDK built-in `WebSearch`** over a third-party search API — no new key, citations built in, less infra. Cost controlled by our daily counter + behavioral per-turn limit.
- **Tiered cost posture, looser cap** — Places runs freely (cheap, shares geo budget); WebSearch rationed at **~15/user/day** so the common "find me a spot" case is always covered while the pricier path stays bounded.
- **WebSearch biased to trusted sources** via `allowed_domains` (curated, generous) — quality-gates results and reinforces the never-invent rule.
- **What's Happening + Know Things both get `find_places` and `WebSearch`; Find People gets neither.**

---

## 10. Out of scope → Phase 2 preview (separate spec)

Background ingestion of 小红书/大众点评 via an Apify actor (pattern: `src/scrapers/instagram.ts`) on a cron, extracting structured spots (name/address/category/rating/booking) into a new Postgres table that `find_places` (or a sibling `find_local_spots`) can read first before falling back to the live Google path. Solves coverage of niche Chinese categories without live-latency/brittleness. Owns its own caching, dedup, and ToS/rate-limit handling.
