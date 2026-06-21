# P6 — Observational Memory Design

> george (BIA's AI iMessage agent) · 2026-06-21 · approved design
> Builds directly on the completed memory consolidation (clean 2-store model:
> `students` = form-truth, `user_profiles` = 6-block learned memory + atomic
> `append_to_profile_block` RPC + heartbeat compaction). This is HANA plan P6,
> the Track-3 Mastra-memo's recommendation (A): build observational memory
> NATIVELY on Supabase — no Mastra, no PII migration, keep direct Anthropic.

## 1. Goal

Make George *actually remember you* — surface the right past detail at the right
moment ("you said CSCI 270 was kicking your ass 3 weeks ago — how'd the final
go?"), which the current always-loaded capped profile blocks structurally
cannot do. We add the full observational-memory loop: an **Observer** that
writes a dense, embedded, timestamped observation log; per-turn **Recall** that
auto-injects the most relevant past observations; and a **Reflector** that
periodically folds durable patterns into the 6-block profile and prunes the log.

## 2. What exists today (do not rebuild)

- **`src/memory/capture.ts`** (`MEMORY_CAPTURE_ENABLED`, ON in prod): per-turn,
  fire-and-forget. A lightweight LLM extracts *durable facts* from the turn and
  `appendToBlock`s them into 5 of the 6 blocks (not `george_notes`). This is an
  eager fact→block extractor — P6 extends it, does not replace it.
- **`src/memory/profile.ts`**: 6 markdown blocks + `relationship_note` +
  `compaction_due`, KV-cached (5min). `renderForPrompt` injects **all** blocks
  every turn (each capped 4000 chars). Atomic deduped `appendToBlock` via the
  `append_to_profile_block` RPC. **Recall today = always-load everything; no
  relevance retrieval.**
- **`src/agent/heartbeat.ts`** (`runHeartbeat`, ~12h): loads recent messages +
  followups; `compactProfileIfDue` condenses over-cap blocks. A lightweight
  Reflector already lives here — P6 adds a consolidation pass alongside it.
- **Embedding infra**: `embedText()` (`src/tools/campus-knowledge.ts`, OpenAI
  `text-embedding-3-small`, 1536-d, needs `OPENAI_API_KEY` in george) AND the
  squad `embed` Supabase Edge Function (`supabase.functions.invoke('embed')`,
  key server-side). Vector search is done via SECURITY DEFINER RPCs
  (`hybrid_search_posts_for_user`, `match_users_for_post`). P6 mirrors these.

## 3. Non-goals (YAGNI)

- No Mastra / framework. No migration of existing PII tables.
- No recall *tool* in the MVP (a tool would silently never fire on fast-path
  turns; auto-injection works on every path). A `recall()` tool is a possible
  later add, out of scope here.
- No replacement of `capture.ts` fact extraction — it stays.
- No new cron — the Reflector reuses the existing heartbeat tick.

## 4. Architecture — the loop

```
─ per turn ──────────────────────────────────────────────────────────────────
 user turn ─▶ capture LLM call (EXTENDED) ─┬─▶ facts        ─▶ user_profiles blocks   (today)
                                           └─▶ observations ─▶ user_observations  (NEW: embedded, timestamped)

 user turn ─▶ embed(message) ─▶ recall_observations RPC ─▶ top-K ─▶ "## THINGS YOU REMEMBER" in prompt
                                                                     (BOTH agent path + fast path)

─ ~12h heartbeat (Reflector) ─────────────────────────────────────────────────
 user_observations ─▶ fold salient/recurring obs into profile blocks ─▶ mark consolidated ─▶ age/prune
```

Three new units around one new store, each with a single responsibility and a
flag of its own; the Reflector is the only bridge from the log into the profile.

## 5. New store — `user_observations` (bia-admin migration)

Owned by bia-admin (`supabase/migrations/`), applied to prod **before** george
code reads/writes it (migration-then-code). george only reads/writes it.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint generated always as identity` PK | |
| `user_id` | `uuid not null` | same key as `user_profiles.user_id` (resolved `students.user_id`) |
| `content` | `text not null` | short 3rd-person observation |
| `embedding` | `vector(1536)` null | `text-embedding-3-small`; nullable (best-effort, like squad) |
| `salience` | `smallint not null default 3` | 1–5, Observer-rated; weights recall + Reflector promotion |
| `kind` | `text` | `fact`\|`event`\|`emotion`\|`preference`\|`relationship` (telemetry/filter) |
| `source` | `text not null default 'observer'` | future-proofs manual/other sources |
| `created_at` | `timestamptz not null default now()` | |
| `consolidated_at` | `timestamptz` null | set by the Reflector when folded into a block |

Indexes: vector index on `embedding` for cosine (`vector_cosine_ops`, ivfflat or
hnsw — match what campus_knowledge/squad use); btree on `(user_id, created_at desc)`.

**Why a 3rd store right after consolidating to 2:** the mess we fixed was
*duplicate data under two keys*. This is a clean new **layer** under one key
(`user_id`): an append-only episodic log with a different shape (vectors +
time-series) and a different access pattern (semantic retrieval, not
always-load). The Reflector is the single bridge into `user_profiles`. Layering,
not re-tangling.

### Recall RPC
`recall_observations(p_user_id uuid, p_query_embedding vector(1536), p_match_count int, p_min_salience int)`
— SECURITY DEFINER, returns the top-N observations for the user ranked by a
blended score (§7). Mirrors the squad match RPCs. Service-role only.

## 6. Components

### 6.1 Observer — extend `src/memory/capture.ts`
- Extend the extraction prompt + output schema:
  `{"facts":[{block,fact}], "observations":[{content,salience,kind}]}`.
- `facts` → `appendToBlock` (unchanged). `observations` → embed via the `embed`
  Edge Function (best-effort) → insert into `user_observations` (service-role).
- The per-turn memory pass runs if `isCaptureEnabled() || isObserveEnabled()`;
  facts written only if capture on, observations only if observe on.
- Fire-and-forget; no reply latency. Same `resolveProfileUserId` guard — skip
  non-onboarded handles (the uuid column can't hold a channel handle).
- Observer prompt captures the *softer* stuff capture skips: mood/emotional
  context, episodic events ("celebrated X"), recurring patterns, relational
  beats — not just durable facts. Never invent; only what the student said/did.

### 6.2 Recall — new `src/memory/recall.ts`
- `recallObservations(userId, currentMessage) → string` (the render-ready block
  or `''`). Steps: resolve user_id → embed `currentMessage` (Edge Fn) → call
  `recall_observations` RPC (top-K, min-salience) → render compact
  `## THINGS YOU REMEMBER` (≤ ~600 chars, newest/most-salient first).
- Injected by the prompt builders alongside the profile, on **both** the agent
  path and the fast path. On the critical path (must complete before the reply),
  but cheap (one embed + one indexed query). Any failure / no results / no
  embedding / non-onboarded handle → return `''` (inject nothing, never throw,
  never block).
- Budget-capped so the prompt stays lean.

### 6.3 Reflector — extend `src/agent/heartbeat.ts`
- New pass in `runHeartbeat` (alongside `compactProfileIfDue`): load recent
  un-consolidated, ≥min-salience observations for the user → lightweight LLM
  folds durable/recurring patterns into the right block via `appendToBlock`
  (atomic, deduped) → set `consolidated_at = now()` on those rows.
- **Prune** to keep the log bounded: delete observations that are (consolidated
  AND older than `PRUNE_DAYS`, default 30) OR (low-salience `salience <= 1` AND
  older than `PRUNE_DAYS`). Keep recent + high-salience un-consolidated rows for
  recall.
- Reuses the heartbeat cadence (no new cron). Fails safe (errors logged, tick
  continues; original data untouched).

## 7. Recall scoring

Blended in SQL (RPC), like squad's hybrid search:
`score = w_sim·cosine_similarity + w_rec·recency_decay + w_sal·(salience/5)`,
filter `salience >= p_min_salience`, order by score desc, limit `p_match_count`.
- `recency_decay = exp(-age_days / HALF_LIFE)` (half-life default 14d).
- MVP defaults: top-K=4, min-salience=2, weights ~ (0.6 sim, 0.25 recency,
  0.15 salience). Tunable; documented as constants.

## 8. Flags (all default-OFF, independent, staged)

| Flag | Gates | Roll out |
|---|---|---|
| `GEORGE_OBSERVE_ENABLED` | Observer writes observations | 1st — accumulate a log |
| `GEORGE_RECALL_ENABLED` | per-turn recall injection | 2nd — the visible payoff |
| `GEORGE_REFLECT_ENABLED` | heartbeat Reflector consolidate+prune | 3rd |

OFF = byte-identical behavior to today. New tunables also as env, with defaults:
`RECALL_TOP_K=4`, `RECALL_HALF_LIFE_DAYS=14`, `RECALL_MIN_SALIENCE=2`,
`REFLECT_PRUNE_DAYS=30`.

## 9. Safety / PII

- Observations are real user PII → default-OFF, keyed by resolved
  `students.user_id`, never written for non-onboarded handles, service-role/RPC
  only (never via HTTP, never logged).
- **`/delete me` MUST also wipe `user_observations`** — extend the existing
  delete-user path to the new table (the 6-table delete becomes 7).
- Recalled content injected into the prompt is **data**, subject to the same
  voice/anti-fabrication rules; size-capped.

## 10. Error handling

Every component fire-and-forget or no-op on failure; none blocks/slows a reply.
Embed failure → store observation with null embedding (recallable after a future
backfill), or skip injection — never throw. Reflector LLM failure → log, leave
rows un-consolidated, retry next tick.

## 11. Testing

- Pure unit tests (mock LLM + store + RPC, **zero** API calls in CI — same
  discipline as `capture`/`heartbeat` tests): Observer output parsing
  (facts+observations, malformed JSON tolerance), recall render + budget cap +
  empty/failure no-op, Reflector selection + prune predicate.
- Migration applied additively and **verified before** code deploys
  (migration-then-code). `/delete me` E2E covers `user_observations`.
- CI (tsc + vitest) gates every PR; paid/eval suites stay skipped.

## 12. Phased delivery (~1 week)

- **Phase 0** — bia-admin migration: `user_observations` table + indexes +
  `recall_observations` RPC. Apply to prod (explicit user confirmation), verify.
- **Phase 1** — Observer (extend `capture.ts`) + `user_observations` writer.
  Deploy, flip `GEORGE_OBSERVE_ENABLED`, let the log accumulate.
- **Phase 2** — Recall (`recall.ts` + prompt-builder injection on both paths).
  Deploy, flip `GEORGE_RECALL_ENABLED`, dogfood the "he remembers" payoff.
- **Phase 3** — Reflector + prune (heartbeat) + `/delete me` extension. Deploy,
  flip `GEORGE_REFLECT_ENABLED`.

Each phase is CI-gated, default-OFF, and independently shippable.

## 13. Cross-repo

bia-admin owns the schema (the `user_observations` migration + `recall_observations`
RPC). george deploys migration-then-code. The `OPENAI_API_KEY` used by the
`embed` Edge Function is already configured in Supabase for squad — no new
george env var required.
