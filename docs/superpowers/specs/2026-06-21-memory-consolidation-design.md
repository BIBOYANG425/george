# George Memory Consolidation — Design

> 2026-06-21 ｜ Scope: **cleanup / consolidation of the existing per-user memory**, no new capabilities. Canonical model: the 6-block `user_profiles` profile stays the source of truth + prompt-facing view; we untangle everything around it.

## 1. Problem — the current mess (verified against the live Supabase schema)

Facts about a student live in **three stores with two different keys**, plus a markdown "junk drawer":

- **`students`** — structured identity/onboarding columns (`name`, `major`, `year`, `interests[]`, shipping prefs). Keyed by `students.id` (+ `user_id`).
- **`user_profiles`** — 6 markdown text blocks (`identity`, `academic`, `interests`, `relationships`, `state`, `george_notes`). Keyed by `user_id`.
- **`student_memories`** — `key`/`value`/`category` rows. Keyed by **`student_id`** (a *different* key).

On top of that:
- **Two separate extraction pipelines** write two of these stores: `src/memory/capture.ts` → `user_profiles` blocks, and `src/jobs/memory-extraction.ts` → `student_memories` rows. Redundant, never reconciled.
- **`george_notes` is a junk drawer:** George's free scratchpad **+** a sentinel-fenced `relationship_note` (P3) **+** a `RAISED_THREAD` ledger (P4), three structured things in one string, parsed by regex/sentinels/line-stripping. The code labels these "zero-schema MVP… until a bia-admin migration adds a column." **No `relationship_note` column exists today.**
- **8 writers** touch `user_profiles` blocks (`capture`, `heartbeat`, `evaluators/relationship`, `grounded-proactive`, `orchestrator`, `update-block` tool, `user-commands` `/correct`, `profile`) via read-modify-write (`appendToBlock` loads then `saveBlock` overwrites) — a **lost-update race**, no transaction.
- **Silent data loss:** `MAX_BLOCK_CHARS = 2000` blind-slices the oldest content when a block fills.
- A Cloudflare **KV cache** (5-min TTL) sits over `user_profiles`.

## 2. Goal & non-goals

**Goal:** one coherent per-user memory model with clear ownership, real schema for the structured bits, no lost updates, and no silent truncation — without changing what George can *do*.

**Non-goals (explicitly out of scope):** observational/episodic memory (the deferred P6), any redesign of `students` or the prompt-facing 6-block format, the pgvector RAG layer (campus_knowledge/courses — that's content, not per-user memory), and the iMessage transport.

## 3. Target architecture — two clean stores

| Store | Owns | Key | Writer(s) |
|---|---|---|---|
| **`students`** | **Form truth** — identity + onboarding facts the student supplied (name, major, year, interests[], shipping prefs). Stable. | `students.id` / `user_id` | onboarding form; `/correct` of an identity field |
| **`user_profiles`** (6 blocks) | **Learned memory** — what George picks up in conversation, evolving. | `user_id` | `capture`, `heartbeat`, `/correct` |

**The rule that removes the overlap:** `students` = *what the student told the form*; `user_profiles` = *what George learned talking to them*. Capture never writes `students`. The prompt renders **both** (a `students`-derived facts header + the 6 blocks), so nothing is lost by the split. `student_memories` (the redundant third store, different key) is **retired**.

The two structured things currently hidden in `george_notes` get real homes; `george_notes` reverts to being only George's scratchpad.

## 4. Components & changes

### 4.1 `relationship_note` → dedicated column
- Add `user_profiles.relationship_note text`.
- **Sole writer:** `src/agent/evaluators/relationship.ts` (writes the column directly; no more sentinel rewrite-in-blob).
- **Reader:** `buildRelationshipNoteBlock()` in `orchestrator.ts` reads the column.
- Delete `REL_NOTE_START/END`, `REL_NOTE_BLOCK_RE`, `extractRelationshipNote`, `upsertRelationshipNote` from `profile.ts` after backfill.

### 4.2 `raised_thread` ledger → dedicated table
- Create `proactive_raised_threads (id uuid pk, user_id uuid, thread text, raised_at timestamptz default now())`, indexed on `user_id`.
- **Sole writer/reader:** `src/agent/grounded-proactive.ts` (insert a row when a thread is raised; query by `user_id` to dedupe).
- Delete `stripRaisedThreadLines` + the line-stuffing; `renderForPrompt`/`buildUserProfileBlock` no longer special-case `george_notes`.

### 4.3 `george_notes` → scratchpad only
- After 4.1/4.2, `george_notes` holds only George's free heartbeat scratchpad. One writer (heartbeat). Nothing is parsed out of it.

### 4.4 Atomic block append (kill the race) — Postgres RPC
- Create `append_to_profile_block(p_user_id uuid, p_block text, p_addition text)` that, in one transaction: loads the block, skips if the addition is already a contained line (server-side dedupe), appends, and writes back.
- `ProfileStore.appendToBlock` calls this RPC instead of read-modify-write; on success it invalidates the KV cache key. On RPC error it logs `memory_append_failed` and does not crash the turn (capture is fire-and-forget).
- `p_block` is validated against the allowed block names inside the function (reject others).

### 4.5 Truncation → compaction, never blind-slice
- Raise `MAX_BLOCK_CHARS` to **4000**.
- The append RPC **never slices**; if an append would push a block over the cap it still appends (a temporary overflow is acceptable; we never silently drop) and sets a single `user_profiles.compaction_due timestamptz` marker.
- The **heartbeat** (already runs per-user, already holds `update_block` + an LLM) gets one new step: when `compaction_due` is set, it summarizes/dedupes the over-cap block(s) back under the cap and clears the marker. This reuses the existing heartbeat; it is not a new subsystem.
- Every compaction logs `memory_compacted {userId, block, before, after}`.

### 4.6 Retire `student_memories`
- Backfill (one-time): map each `student_memories` row's `category` → the matching block (e.g. `academic`/`interests`/`relationships`/`state`; unknown → `george_notes`), resolve `student_id` → `user_id` via `students`, and append via the new RPC (deduped).
- Delete `src/jobs/memory-extraction.ts` and its scheduler wiring.
- Repoint `src/tools/get-student-academic-state.ts` to read `students` + `user_profiles` instead of `student_memories`.
- Update `session-store.ts` `/delete me` to drop the `student_memories` delete once the table is gone; admin analytics (`analytics.ts`, `dashboard-html.ts`, `logger.ts` count) drop the `student_memories` references.
- Drop the table (bia-admin migration) **after** backfill is verified.

## 5. Data flow after consolidation

- **Read (per turn):** prompt = `students`-facts header + 6 blocks (`buildUserProfileBlock`) + `relationship_note` column (when the eval flag is on) + onboarding nudge. `proactive_raised_threads` is read only by the proactive cron, never injected.
- **Write:** `capture` → `append_to_profile_block` RPC (learned facts); `relationship-eval` → `relationship_note` column; `grounded-proactive` → `proactive_raised_threads` insert; `heartbeat` → `george_notes` + compaction; `/correct` → `saveBlock` (full overwrite of one block) or a `students` column for identity fields.

## 6. Schema migrations (owned by bia-admin, cross-repo)

1. `ALTER TABLE user_profiles ADD COLUMN relationship_note text, ADD COLUMN compaction_due timestamptz;`
2. `CREATE TABLE proactive_raised_threads (...)` + index on `user_id`.
3. `CREATE FUNCTION append_to_profile_block(...)` (SECURITY DEFINER, validates block name, dedupes, appends).
4. (Phase 2) `DROP TABLE student_memories;`

George only reads/writes existing tables, so each of these lands in bia-admin first; George's code is gated to tolerate the column/table/RPC being absent until the migration is applied (feature-flag or capability check), so deploy order is migration-then-code.

## 7. Migration plan — phased, additive-first (safe on live PII)

- **Phase 1 — additive (no removal):** apply migrations 1–3. Ship code that (a) writes `relationship_note` to the new column, (b) writes `proactive_raised_threads`, (c) uses the append RPC, (d) heartbeat-compacts. Reads tolerate old + new (dual-read during transition). Run one-time backfills: extract relationship-note + raised-threads out of `george_notes` into their new homes; migrate `student_memories` rows into blocks.
- **Phase 2 — remove:** once Phase 1 is verified in prod, delete `memory-extraction.ts`, repoint `get-student-academic-state`, strip the sentinel/ledger parsing from `george_notes`, drop `student_memories` (migration 4).

Each phase is independently shippable and reversible; no destructive step runs before its additive counterpart is verified.

## 8. Error handling

- Append RPC failure → log `memory_append_failed`, turn proceeds (capture is best-effort, never blocks a reply).
- Backfill is idempotent (the RPC dedupes), so it can be re-run safely; it logs per-user counts and any unresolved `student_id`→`user_id` rows (skipped, not lost).
- KV cache invalidation on every write path (RPC + `saveBlock`); a missed invalidation self-heals at the 5-min TTL.
- Migration-before-code: code paths capability-check the new column/table/RPC so a code deploy ahead of the migration degrades to the old behavior rather than erroring.

## 9. Testing

- **Unit:** `append_to_profile_block` dedupe + cap behavior (against a test DB or a mock matching the RPC contract); `relationship_note` column read/write; `proactive_raised_threads` insert/dedupe; heartbeat compaction reduces an over-cap block under the cap; `get-student-academic-state` reads the new sources.
- **Backfill:** a fixture covering a `george_notes` blob with a fenced note + raised-thread lines + scratchpad → asserts the note lands in the column, threads in the table, scratchpad preserved; `student_memories` rows → correct blocks; unresolved keys skipped.
- **Regression:** the existing suite (700+) stays green; CI (tsc + vitest) gates it.
- **No-PII-loss check:** a count/spot-check that every pre-migration `student_memories` row + every fenced note is represented post-backfill (logged, verifiable before the Phase 2 drop).

## 10. Open items / risks

- **Cross-repo coordination:** the 4 migrations live in bia-admin; George deploys must follow them. Phase gating handles ordering.
- **`student_id` ↔ `user_id` reconciliation:** any `student_memories` row whose `student_id` doesn't resolve to a `user_id` is skipped + logged (not silently dropped) for manual review.
- **`compaction_due` overflow window:** between an over-cap append and the next heartbeat, a block may briefly exceed 4000 chars in the prompt. Acceptable (no data loss; bounded by heartbeat cadence). If it proves a problem, compaction can move inline.
