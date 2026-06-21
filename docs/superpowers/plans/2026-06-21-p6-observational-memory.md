# P6 Observational Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give George a "remembers you" recall layer — an embedded observation log written per-turn, auto-injected by relevance each turn, and periodically folded into the 6-block profile.

**Architecture:** A new `user_observations` vector store (bia-admin migration). Observer = extend the existing per-turn `capture.ts` call to also emit observations. Recall = per-turn embed-query → `recall_observations` RPC → inject a compact block on both the agent and fast paths. Reflector = a heartbeat pass that folds salient observations into profile blocks and prunes the log. Three default-OFF flags, staged observe→recall→reflect.

**Tech Stack:** TypeScript/Node, Supabase (pgvector + SECURITY DEFINER RPC + `embed` Edge Function), OpenAI `text-embedding-3-small` (1536-d), vitest.

**Spec:** `docs/superpowers/specs/2026-06-21-p6-observational-memory-design.md`

**Key conventions (from the consolidation):**
- bia-admin owns schema; george deploys migration-then-code. **PROD-APPLY OF THE MIGRATION IS PARKED for Bobby** (see the loop charter) — write + PR the migration only.
- Atomic block writes go through `ProfileStore.appendToBlock` (the `append_to_profile_block` RPC).
- Embedding: `supabase.functions.invoke('embed', { body: { texts: [t] } })` → `data.embeddings[0]`, best-effort (try/catch → null).
- Memory writers resolve the channel handle to `students.user_id` via `resolveProfileUserId` and skip non-onboarded handles.
- All new behavior behind a default-OFF flag; OFF = byte-identical. Pure unit tests, zero API calls in CI.

---

## Phase 0 — bia-admin schema (FILE + PR only; prod-apply PARKED)

### Task 0.1: `user_observations` table + indexes + `recall_observations` RPC

**Files:**
- Create (in a bia-admin git worktree, base `main`, NOT the dirty `fix/doc-george-paths` branch): `supabase/migrations/20260621130000_p6_user_observations.sql`

- [ ] **Step 1: Write the migration**

```sql
-- P6 observational memory: an append-only, embedded, per-user observation log.
-- Separate layer from user_profiles (different shape: vectors + time-series;
-- different access pattern: semantic retrieval, not always-load). The george
-- heartbeat Reflector is the only bridge into user_profiles.
create extension if not exists vector;

create table if not exists public.user_observations (
  id              bigint generated always as identity primary key,
  user_id         uuid not null,
  content         text not null,
  embedding       vector(1536),
  salience        smallint not null default 3 check (salience between 1 and 5),
  kind            text,
  source          text not null default 'observer',
  created_at      timestamptz not null default now(),
  consolidated_at timestamptz
);

create index if not exists user_observations_user_created_idx
  on public.user_observations (user_id, created_at desc);
create index if not exists user_observations_embedding_idx
  on public.user_observations using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Blended recall: cosine similarity + recency decay + salience, salience-gated.
create or replace function public.recall_observations(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 4,
  p_min_salience int default 2,
  p_half_life_days double precision default 14
)
returns table (id bigint, content text, salience smallint, kind text, created_at timestamptz, score double precision)
language sql stable security definer set search_path = public as $$
  select o.id, o.content, o.salience, o.kind, o.created_at,
    (0.60 * (1 - (o.embedding <=> p_query_embedding))
     + 0.25 * exp(-(extract(epoch from (now() - o.created_at)) / 86400.0) / nullif(p_half_life_days,0))
     + 0.15 * (o.salience::double precision / 5.0)) as score
  from public.user_observations o
  where o.user_id = p_user_id
    and o.embedding is not null
    and o.salience >= p_min_salience
  order by score desc
  limit greatest(p_match_count, 1);
$$;
```

- [ ] **Step 2: Commit + open the bia-admin PR** (base main). Body: additive, P6 Phase 0, prod-apply intentionally deferred. Do NOT apply to prod.

---

## Phase 1 — Observer (write the log)

### Task 1.1: Observation store seam — `src/memory/observations.ts`

**Files:**
- Create: `src/memory/observations.ts`
- Test: `tests/memory/observations.test.ts`

Define the DB seam + a service-role implementation. Interface (one place all three phases use):

```ts
export interface Observation { content: string; salience: number; kind?: string }
export interface RecalledObservation { id: number; content: string; salience: number; kind: string | null; created_at: string; score: number }
export interface UnconsolidatedObservation { id: number; content: string; salience: number; kind: string | null; created_at: string }

export interface ObservationDB {
  insert(userId: string, obs: Observation, embedding: number[] | null): Promise<void>;
  recall(userId: string, queryEmbedding: number[], matchCount: number, minSalience: number): Promise<RecalledObservation[]>;
  loadUnconsolidated(userId: string, minSalience: number, limit: number): Promise<UnconsolidatedObservation[]>;
  markConsolidated(ids: number[]): Promise<void>;
  prune(userId: string, pruneDays: number): Promise<number>; // delete (consolidated OR salience<=1) AND older than pruneDays; return count
  deleteForUser(userId: string): Promise<void>;
}
export function createSupabaseObservationDB(): ObservationDB { /* createServiceRoleClient(); .from('user_observations') + .rpc('recall_observations', {...}) */ }

// Shared embed helper (best-effort), mirrors create-squad-post.ts:
export async function embedObservation(text: string): Promise<number[] | null>;
```

- [ ] Tests: a fake `ObservationDB` round-trips insert/recall/markConsolidated/prune/delete shapes; `embedObservation` returns null on a thrown invoke (mock supabase). No real network.

### Task 1.2: Observer — extend `src/memory/capture.ts`

**Files:**
- Modify: `src/memory/capture.ts`
- Test: `tests/memory/capture.test.ts` (extend)

- [ ] Add `isObserveEnabled()` = `process.env.GEORGE_OBSERVE_ENABLED === 'true'`.
- [ ] Extend `EXTRACT_SYSTEM` to also request `"observations":[{"content","salience"(1-5),"kind"}]` — the softer/episodic stuff capture's facts skip (mood, events, recurring patterns, relational beats). Never invent.
- [ ] Extend `parseFacts` (or add `parseObservations`) to pull `observations` from the same JSON.
- [ ] Restructure the guard: run the LLM pass if `isCaptureEnabled() || isObserveEnabled()`; write facts only if capture on, observations only if observe on. Keep fire-and-forget + the `resolveProfileUserId` skip.
- [ ] For each observation (when observe on): `embedObservation(content)` (best-effort) → `observationDB.insert(profileKey, obs, embedding)`. Inject the `ObservationDB` (default `createSupabaseObservationDB()`) so tests pass a fake.
- [ ] Tests: observe-off → no observation writes; observe-on → parses + inserts observations (fake DB), tolerates malformed JSON, still writes facts independently; non-onboarded handle → skip.

---

## Phase 2 — Recall (inject by relevance)

### Task 2.1: `src/memory/recall.ts`

**Files:**
- Create: `src/memory/recall.ts`
- Test: `tests/memory/recall.test.ts`

```ts
export function isRecallEnabled(): boolean; // GEORGE_RECALL_ENABLED === 'true'
// Returns a render-ready block or '' (never throws, never blocks).
export async function recallForTurn(userId: string, message: string, db?: ObservationDB): Promise<string>;
```
- [ ] If `!isRecallEnabled()` → `''`. Resolve handle → skip if non-onboarded. `embedObservation(message)` → null → `''`. `db.recall(key, emb, RECALL_TOP_K=4, RECALL_MIN_SALIENCE=2)` → render `## THINGS YOU REMEMBER\n- ...` (newest/highest first), hard-cap ~600 chars. Any throw → `''` (log warn).
- [ ] Tunables from env with defaults (RECALL_TOP_K=4, RECALL_MIN_SALIENCE=2).
- [ ] Tests: disabled → ''; empty recall → ''; embed-fail → ''; renders + caps a list from a fake DB; non-onboarded → ''.

### Task 2.2: Inject recall into the prompt builders

**Files:**
- Modify: `src/agent/orchestrator.ts` (orchestrator + single-agent + trunk system-prompt builders) and `src/agent/fast-path.ts`
- Test: `tests/agent/recall-injection.test.ts`

- [ ] Call `recallForTurn(userId, userMessage)` where the profile block is assembled and append the returned string (if non-empty) to the system prompt, on every path (orchestrator, single-agent, trunk, fast-path). Mirror how `renderForPrompt(profile)` is injected.
- [ ] OFF (`GEORGE_RECALL_ENABLED` unset) → byte-identical prompt (recallForTurn returns '' immediately). Add an equivalence-style assertion.
- [ ] Tests: with a stub recall returning a block, each path includes it; disabled → absent.

---

## Phase 3 — Reflector + prune + delete

### Task 3.1: Reflector in the heartbeat

**Files:**
- Modify: `src/agent/heartbeat.ts` (add `reflectObservations(...)` called from `runHeartbeat` alongside `compactProfileIfDue`); wire `ObservationDB` into `HeartbeatDeps`
- Test: `tests/agent/heartbeat-reflect.test.ts`

- [ ] `isReflectEnabled()` = `GEORGE_REFLECT_ENABLED === 'true'`. If off → no-op.
- [ ] `reflectObservations(store, observationDB, userId, summarize)`: `loadUnconsolidated(userId, minSalience=2, limit=N)` → if any, lightweight-LLM folds durable/recurring patterns into the right block(s) via `store.appendToBlock` (atomic, deduped) → `markConsolidated(ids)`. Then `observationDB.prune(userId, REFLECT_PRUNE_DAYS=30)`. Fail-safe: errors logged, tick continues, rows left un-consolidated.
- [ ] Tests (mock LLM + fake DB): folds + marks consolidated; prune called; off → no-op; LLM throw → rows stay un-consolidated, no crash.

### Task 3.2: Extend `/delete me` to wipe `user_observations`

**Files:**
- Modify: the delete-user path (`src/tools/user-commands.ts` / wherever the 6-table delete lives) to also call `observationDB.deleteForUser(userId)`
- Test: extend the delete test

- [ ] Find the existing multi-table delete; add `user_observations`. Test asserts the new table is included.

### Task 3.3: Document the flags + tunables

**Files:**
- Modify: `.env.example` (add `GEORGE_OBSERVE_ENABLED`, `GEORGE_RECALL_ENABLED`, `GEORGE_REFLECT_ENABLED`, `RECALL_TOP_K`, `RECALL_MIN_SALIENCE`, `RECALL_HALF_LIFE_DAYS`, `REFLECT_PRUNE_DAYS`, all OFF/defaults) + a short `## P6 observational memory` note in CLAUDE.md or AGENT.md memory section if appropriate.

- [ ] No test (docs). Run full `tsc --noEmit` + `vitest run` to confirm the whole feature is green.

---

## Verification
- After every task: `npx tsc --noEmit` and the task's `vitest` file green.
- At phase boundaries: full `npx vitest run` + open a phase PR, confirm CI (`build-and-test`) green, merge (default-OFF, reviewed).
- Default-OFF equivalence proves zero regression when unset.
- **PARKED for Bobby (activation checklist):** apply the bia-admin migration to prod → deploy default-OFF code → dogfood flags observe→recall→reflect on /georgebeta.

## Critical files
- `src/memory/capture.ts` (Observer), `src/memory/observations.ts` (new store seam), `src/memory/recall.ts` (new), `src/memory/profile.ts` (appendToBlock reuse)
- `src/agent/orchestrator.ts` + `src/agent/fast-path.ts` (recall injection), `src/agent/heartbeat.ts` (Reflector)
- bia-admin `supabase/migrations/20260621130000_p6_user_observations.sql`
