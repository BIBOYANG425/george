# George Memory Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Untangle George's per-user memory into two clean stores (`students` = form truth, `user_profiles` 6 blocks = learned memory), give the two structured things hidden in `george_notes` real schema, kill write races and silent truncation, and retire the redundant `student_memories` store.

**Architecture:** Phased, additive-first. bia-admin owns all schema changes; George code deploys *after* each migration and capability-checks the new column/table/RPC so a code-ahead deploy degrades to old behavior instead of erroring. Phase 1 adds the new homes + dual-reads; a one-time backfill moves data; Phase 2 removes the old paths and drops the dead table.

**Tech Stack:** TypeScript (Node/Express), `@supabase/supabase-js` (service-role), Postgres + a `SECURITY DEFINER` plpgsql function, Vitest, Cloudflare-KV-backed profile cache. CI (`tsc --noEmit` + `vitest run`) gates every PR.

**Spec:** `docs/superpowers/specs/2026-06-21-memory-consolidation-design.md`

**Cross-repo note:** schema lives in **bia-admin** (`supabase/migrations/`). Apply each migration to prod **before** merging the George code that uses it. A live Spectrum transport outage is unrelated and out of scope.

---

## File structure

**bia-admin (schema):**
- `supabase/migrations/<ts>_memory_consolidation_additive.sql` — ADD columns, CREATE table + RPC (Phase 1)
- `supabase/migrations/<ts>_drop_student_memories.sql` — DROP table (Phase 2)

**george (code):**
- Modify `src/memory/profile.ts` — `ProfileDB.loadRow` selects new columns; `appendToBlock` → RPC; add `saveRelationshipNote`; delete sentinel helpers (Phase 2)
- Modify `src/agent/evaluators/relationship.ts` — read/write the `relationship_note` column
- Modify `src/agent/orchestrator.ts` — `buildRelationshipNoteBlock` reads the column; `buildUserProfileBlock` stops special-casing `george_notes`
- Modify `src/agent/grounded-proactive.ts` — read/write `proactive_raised_threads`
- Modify `src/agent/heartbeat.ts` — compaction step on `compaction_due`
- Modify `src/tools/get-student-academic-state.ts` — read `students` + `user_profiles`, not `student_memories`
- Delete `src/jobs/memory-extraction.ts` (orphaned)
- Add `scripts/backfill-memory-consolidation.ts` — one-time idempotent backfill
- Tests under `tests/memory/` + `tests/agent/`

---

## Phase 0 — bia-admin additive migration (do FIRST, apply to prod before any George merge)

### Task 1: Additive schema (columns, table, RPC)

**Files:**
- Create: `bia-admin/supabase/migrations/<timestamp>_memory_consolidation_additive.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- relationship note + compaction marker on the learned-memory profile
alter table public.user_profiles
  add column if not exists relationship_note text,
  add column if not exists compaction_due timestamptz;

-- proactive raised-thread ledger (was line-stuffed into george_notes)
create table if not exists public.proactive_raised_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  thread text not null,
  raised_at timestamptz not null default now()
);
create index if not exists idx_raised_threads_user on public.proactive_raised_threads (user_id);
create unique index if not exists uq_raised_threads_user_thread on public.proactive_raised_threads (user_id, thread);

-- atomic, deduped append to one profile block (kills the read-modify-write race)
create or replace function public.append_to_profile_block(
  p_user_id uuid, p_block text, p_addition text
) returns void
language plpgsql security definer
as $$
declare
  v_current text;
  v_addition text := btrim(p_addition);
begin
  if p_block not in ('identity','academic','interests','relationships','state','george_notes') then
    raise exception 'invalid block name: %', p_block;
  end if;
  if v_addition = '' then return; end if;

  insert into public.user_profiles (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  execute format('select %I from public.user_profiles where user_id = $1', p_block)
    into v_current using p_user_id;
  v_current := coalesce(v_current, '');

  -- dedupe: skip if any existing line equals or contains the addition
  if exists (
    select 1 from unnest(string_to_array(v_current, E'\n')) ln
    where btrim(ln) = v_addition or btrim(ln) like '%' || v_addition || '%'
  ) then
    return;
  end if;

  execute format(
    'update public.user_profiles set %I = case when coalesce(%I,'''') = '''' then $2 else %I || E''\n'' || $2 end, '
    || 'compaction_due = case when length(coalesce(%I,'''')) + length($2) + 1 > 4000 then now() else compaction_due end, '
    || 'updated_at = now() where user_id = $1', p_block, p_block, p_block, p_block)
    using p_user_id, v_addition;
end $$;
```

- [ ] **Step 2: Apply + verify in bia-admin (their workflow)**

Run (from bia-admin): `supabase db push` (or the project's migration apply). Then verify:
```sql
select column_name from information_schema.columns where table_name='user_profiles' and column_name in ('relationship_note','compaction_due');
select proname from pg_proc where proname='append_to_profile_block';
select to_regclass('public.proactive_raised_threads');
```
Expected: both columns, the function, and the table all present.

- [ ] **Step 3: Commit (bia-admin repo)**

```bash
git add supabase/migrations/<timestamp>_memory_consolidation_additive.sql
git commit -m "feat(memory): additive schema for george memory consolidation (relationship_note, raised-threads, append RPC)"
```

---

## Phase 1 — George code (additive: write new homes, dual-read old)

> Branch off `main`: `git checkout main && git pull && git checkout -b feat/memory-consolidation-p1`

### Task 2: `relationship_note` → dedicated column

**Files:**
- Modify: `src/memory/profile.ts` (loadRow select; add `saveRelationshipNote`)
- Modify: `src/agent/evaluators/relationship.ts` (write column; read column with george_notes fallback)
- Modify: `src/agent/orchestrator.ts` (`buildRelationshipNoteBlock` reads `profile.relationship_note ?? extractRelationshipNote(george_notes)`)
- Test: `tests/memory/relationship-note-column.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/memory/relationship-note-column.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { ProfileStore, EMPTY_PROFILE } from '../../src/memory/profile.js';
import { createInMemoryCache } from '../../src/memory/kv-cache.js';

function store() {
  const rows = new Map<string, Record<string, string>>();
  const db = {
    async loadRow(uid: string) { return rows.get(uid) ?? null; },
    async upsertBlock() {},
    async saveRelationshipNote(uid: string, note: string) {
      rows.set(uid, { ...(rows.get(uid) ?? { user_id: uid }), relationship_note: note });
    },
  };
  return { s: new ProfileStore(db as any, createInMemoryCache()), rows };
}

it('writes + reads relationship_note via its own column', async () => {
  const { s } = store();
  await s.saveRelationshipNote('u1', 'they ghost on weekends, finals stress');
  const p = await s.loadProfile('u1');
  expect(p.relationship_note).toBe('they ghost on weekends, finals stress');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `env -u DEEPSEEK_API_KEY npx vitest run tests/memory/relationship-note-column.test.ts`
Expected: FAIL — `saveRelationshipNote` / `relationship_note` not on Profile.

- [ ] **Step 3: Add `relationship_note` to the Profile type + loadRow + a writer** (`src/memory/profile.ts`)

In `Profile`/`EMPTY_PROFILE` add `relationship_note: string`. In `ProfileDB` add `saveRelationshipNote(userId, note): Promise<void>`. In `loadProfile`, map `relationship_note: row.relationship_note ?? ''`. Add:
```ts
async saveRelationshipNote(userId: string, note: string): Promise<void> {
  await this.db.saveRelationshipNote(userId, note);
  await this.cache.delete(this.cacheKey(userId));
}
```
In `createSupabaseProfileDB`, add:
```ts
async saveRelationshipNote(userId, note) {
  const { error } = await supabase.from('user_profiles')
    .upsert({ user_id: userId, relationship_note: note, updated_at: new Date().toISOString() });
  if (error) throw new Error(`saveRelationshipNote failed: ${error.message}`);
},
```
And add `relationship_note` to the loadRow select (it uses `select('*')`, so already covered).

- [ ] **Step 4: Run test, verify pass**

Run: `env -u DEEPSEEK_API_KEY npx vitest run tests/memory/relationship-note-column.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the evaluator + orchestrator at the column**

`src/agent/evaluators/relationship.ts` `runRelationshipEval`: read prior from `profile.relationship_note || extractRelationshipNote(profile.george_notes ?? '')` (dual-read), and write the new note via `profileStore.saveRelationshipNote(userId, note)` instead of `upsertRelationshipNote` into george_notes.
`src/agent/orchestrator.ts` `buildRelationshipNoteBlock`: read `const note = profile.relationship_note || extractRelationshipNote(profile.george_notes ?? '')`.

- [ ] **Step 6: tsc + full suite + commit**

```bash
npx tsc --noEmit && env -u DEEPSEEK_API_KEY npx vitest run
git add src/memory/profile.ts src/agent/evaluators/relationship.ts src/agent/orchestrator.ts tests/memory/relationship-note-column.test.ts
git commit -m "feat(memory): relationship_note in its own column (dual-read from george_notes)"
```

### Task 3: `raised_thread` ledger → dedicated table

**Files:**
- Modify: `src/agent/grounded-proactive.ts` (DB-backed raised set + insert)
- Test: `tests/agent/raised-threads-table.test.ts`

- [ ] **Step 1: Write the failing test** — assert an injected DB seam records + dedupes a raised thread.

```ts
import { describe, it, expect } from 'vitest';
import { recordRaisedThread, loadRaisedThreads } from '../../src/agent/grounded-proactive.js';

it('records + dedupes raised threads via the DB seam', async () => {
  const rows: Array<{ user_id: string; thread: string }> = [];
  const db = {
    async insert(uid: string, t: string) { if (!rows.some(r => r.user_id===uid && r.thread===t)) rows.push({ user_id: uid, thread: t }); },
    async list(uid: string) { return rows.filter(r => r.user_id===uid).map(r => r.thread); },
  };
  await recordRaisedThread(db as any, 'u1', 'visa-opt-question');
  await recordRaisedThread(db as any, 'u1', 'visa-opt-question');
  expect([...(await loadRaisedThreads(db as any, 'u1'))]).toEqual(['visa-opt-question']);
});
```

- [ ] **Step 2: Run it, verify it fails** — `recordRaisedThread`/`loadRaisedThreads` not exported.

Run: `env -u DEEPSEEK_API_KEY npx vitest run tests/agent/raised-threads-table.test.ts` → FAIL.

- [ ] **Step 3: Implement the DB-seam helpers** in `grounded-proactive.ts`

```ts
export interface RaisedThreadDB { insert(userId: string, thread: string): Promise<void>; list(userId: string): Promise<string[]>; }
export async function recordRaisedThread(db: RaisedThreadDB, userId: string, key: string): Promise<void> { await db.insert(userId, key); }
export async function loadRaisedThreads(db: RaisedThreadDB, userId: string): Promise<Set<string>> { return new Set(await db.list(userId)); }
export function createSupabaseRaisedThreadDB(): RaisedThreadDB { /* supabase upsert into proactive_raised_threads on conflict do nothing; select thread where user_id */ }
```
Wire the proactive caller to use `loadRaisedThreads`/`recordRaisedThread` (DB) with a fallback to `parseRaisedThreads(george_notes)` during transition (dual-read).

- [ ] **Step 4: Run test, verify pass.** Run the same command → PASS.

- [ ] **Step 5: tsc + suite + commit**

```bash
npx tsc --noEmit && env -u DEEPSEEK_API_KEY npx vitest run
git add src/agent/grounded-proactive.ts tests/agent/raised-threads-table.test.ts
git commit -m "feat(memory): raised-thread ledger in proactive_raised_threads table (dual-read from george_notes)"
```

### Task 4: Atomic append via the RPC

**Files:**
- Modify: `src/memory/profile.ts` (`appendToBlock` → RPC; `createSupabaseProfileDB` gains `appendBlockAtomic`)
- Test: `tests/memory/append-rpc.test.ts`

- [ ] **Step 1: Failing test** — the ProfileDB seam exposes `appendBlockAtomic`, and `appendToBlock` calls it + invalidates cache.

```ts
it('appendToBlock delegates to the atomic seam and invalidates cache', async () => {
  const calls: any[] = []; let invalidated = false;
  const db = { async loadRow(){return null;}, async upsertBlock(){}, async appendBlockAtomic(u: string,b: string,a: string){calls.push([u,b,a]);} };
  const cache = { get: async()=>null, set: async()=>{}, delete: async()=>{invalidated=true;} };
  const { ProfileStore } = await import('../../src/memory/profile.js');
  const s = new ProfileStore(db as any, cache as any);
  await s.appendToBlock('u1','academic','studies CS, sophomore');
  expect(calls).toEqual([['u1','academic','studies CS, sophomore']]);
  expect(invalidated).toBe(true);
});
```

- [ ] **Step 2: Run, verify fail** (`appendBlockAtomic` not in seam).

- [ ] **Step 3: Implement** — add `appendBlockAtomic(userId, block, addition)` to `ProfileDB`; in `createSupabaseProfileDB` implement it as `supabase.rpc('append_to_profile_block', { p_user_id, p_block: block, p_addition: addition })`. Rewrite `ProfileStore.appendToBlock` to validate block name, call `this.db.appendBlockAtomic(...)`, then `this.cache.delete(...)`. Keep `MAX_BLOCK_CHARS` bumped to 4000 for the `saveBlock` guard.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: tsc + suite + commit**

```bash
npx tsc --noEmit && env -u DEEPSEEK_API_KEY npx vitest run
git add src/memory/profile.ts tests/memory/append-rpc.test.ts
git commit -m "feat(memory): atomic append_to_profile_block RPC (kills read-modify-write race)"
```

### Task 5: Heartbeat compaction (no more blind slice)

**Files:**
- Modify: `src/agent/heartbeat.ts` (read `compaction_due`; compact over-cap blocks; clear marker)
- Modify: `src/memory/profile.ts` (`loadProfile` exposes `compaction_due`; add `clearCompactionDue`)
- Test: `tests/agent/heartbeat-compaction.test.ts`

- [ ] **Step 1: Failing test** — given a profile with `compaction_due` set + an over-cap block, the compaction step calls the LLM-summarize seam and writes a shorter block + clears the marker.

```ts
it('compacts an over-cap block and clears compaction_due', async () => {
  // inject a fake summarizer that halves the text; assert saveBlock called with shorter content + clearCompactionDue called
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — add `compaction_due` to `Profile`/loadProfile; add `clearCompactionDue(userId)` to ProfileStore+DB. In `heartbeat.ts`, after the existing tick logic: if `profile.compaction_due` set, for each block over 4000 chars call the existing lightweight summarizer to dedupe/condense under cap, `saveBlock` it, then `clearCompactionDue`. Log `memory_compacted {userId, block, before, after}`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: tsc + suite + commit**

```bash
npx tsc --noEmit && env -u DEEPSEEK_API_KEY npx vitest run
git add src/agent/heartbeat.ts src/memory/profile.ts tests/agent/heartbeat-compaction.test.ts
git commit -m "feat(memory): heartbeat compaction replaces silent truncation"
```

- [ ] **Step 6: Open PR `feat/memory-consolidation-p1` → main, CI green, merge after the bia-admin migration is live.**

---

## Phase 1.5 — one-time backfill

### Task 6: Backfill script (idempotent) + no-loss check

**Files:**
- Create: `scripts/backfill-memory-consolidation.ts`
- Test: `tests/memory/backfill.test.ts`

- [ ] **Step 1: Failing test** — pure transform: given a `george_notes` blob with a fenced relationship note + `RAISED_THREAD:` lines + scratchpad, `splitGeorgeNotes(blob)` returns `{ note, threads[], scratchpad }`; given `student_memories` rows + a `student_id→user_id` map, `planBackfill(rows, map)` returns block-append ops + a list of unresolved (skipped) rows.

```ts
it('splits a george_notes blob into note / threads / scratchpad', () => {
  const blob = 'real scratch\n<!-- relationship_note:start -->\nthey ghost\n<!-- relationship_note:end -->\nRAISED_THREAD:visa-q';
  const out = splitGeorgeNotes(blob);
  expect(out.note).toBe('they ghost');
  expect(out.threads).toEqual(['visa-q']);
  expect(out.scratchpad).toBe('real scratch');
});
it('skips student_memories rows whose student_id has no user_id', () => {
  const plan = planBackfill([{student_id:'x',category:'academic',value:'CS'}], new Map());
  expect(plan.appends).toEqual([]); expect(plan.unresolved).toEqual(['x']);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** the pure helpers (`splitGeorgeNotes` reuses `extractRelationshipNote` + `parseRaisedThreads` + `stripRaisedThreadLines`; `planBackfill` maps `category`→block, resolves `student_id`→`user_id`, dedupe-safe) and the script runner that: (a) for each `user_profiles` row, split `george_notes` → `saveRelationshipNote`, insert threads, set `george_notes` = scratchpad; (b) load all `student_memories` + a `students(id→user_id)` map, run `planBackfill`, append via the RPC; (c) print per-user counts + unresolved IDs.

- [ ] **Step 4: Run unit test, verify pass.**

- [ ] **Step 5: Dry-run then live-run against prod, with the no-loss check**

```bash
npx tsx scripts/backfill-memory-consolidation.ts --dry-run   # prints planned ops + unresolved
npx tsx scripts/backfill-memory-consolidation.ts             # executes (idempotent; RPC dedupes)
```
Verify: every pre-migration `student_memories` row + every fenced note is represented (the script logs counts; spot-check a few users). Record the unresolved-IDs list for manual review.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-memory-consolidation.ts tests/memory/backfill.test.ts
git commit -m "feat(memory): idempotent backfill from george_notes + student_memories into clean homes"
```

---

## Phase 2 — remove old paths + drop dead table (after Phase 1 + backfill verified in prod)

> Branch: `git checkout main && git pull && git checkout -b feat/memory-consolidation-p2`

### Task 7: Strip the old paths

**Files:**
- Delete: `src/jobs/memory-extraction.ts` (orphaned — nothing imports it)
- Modify: `src/memory/profile.ts` (remove `REL_NOTE_*`, `extractRelationshipNote`, `upsertRelationshipNote`, `stripRaisedThreadLines` usage; `renderForPrompt` no longer special-cases `george_notes`)
- Modify: `src/agent/orchestrator.ts` (`buildRelationshipNoteBlock` reads column only; `buildUserProfileBlock` no `stripRaisedThreadLines`)
- Modify: `src/agent/grounded-proactive.ts` (drop `RAISED_PREFIX`/`parseRaisedThreads`/`raisedThreadLine`/`stripRaisedThreadLines`; DB-only)
- Modify: `src/tools/get-student-academic-state.ts` (read `students` + `user_profiles`; drop the `student_memories` query)
- Modify: `src/agent/session-store.ts` (drop the `student_memories` delete in `/delete me`)
- Modify: `src/admin/analytics.ts`, `src/admin/dashboard-html.ts`, `src/observability/logger.ts` (remove `student_memories` references)

- [ ] **Step 1: Update tests first** — adjust the Task-2/3 tests to drop the george_notes fallback assertions (column/table are now the only path); add a `get-student-academic-state` test asserting it reads `students` + `user_profiles`.
- [ ] **Step 2: Run, verify the new expectations fail.**
- [ ] **Step 3: Make the deletions/edits above.**
- [ ] **Step 4: tsc + full suite green.** Run: `npx tsc --noEmit && env -u DEEPSEEK_API_KEY npx vitest run`
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(memory): drop george_notes parsing + student_memories reads; delete dead memory-extraction"
```

### Task 8: Drop `student_memories` (bia-admin, after Phase 2 code is live)

**Files:**
- Create: `bia-admin/supabase/migrations/<timestamp>_drop_student_memories.sql`

- [ ] **Step 1: Migration**

```sql
drop table if exists public.student_memories;
```

- [ ] **Step 2: Confirm no live readers remain** (Phase 2 code merged + deployed) before applying.
- [ ] **Step 3: Apply + commit (bia-admin).**
- [ ] **Step 4: Open PR `feat/memory-consolidation-p2` → main, CI green, merge + deploy (`railway up --service george`).**

---

## Self-review

- **Spec coverage:** §3 two-store model → Tasks 2–7 + the `students`/`user_profiles` split is enforced by capture writing only `user_profiles` (unchanged). §4.1 relationship_note → Task 2 + 7. §4.2 raised_thread → Task 3 + 7. §4.3 george_notes scratchpad → Task 7. §4.4 atomic RPC → Task 1 + 4. §4.5 truncation→compaction → Task 1 (marker) + 5. §4.6 retire student_memories → Task 6 (backfill) + 7 (reads) + 8 (drop). §6 migrations → Task 1 + 8. §7 phasing → Phase 0/1/1.5/2 ordering. §9 testing → tests in each task + Task 6 no-loss check.
- **Placeholder scan:** the RPC, DDL, writer edits, and test stubs carry real code; `createSupabaseRaisedThreadDB` body and the heartbeat summarizer wiring reference the existing `supabase` client + lightweight LLM (named, not invented). No TODO/TBD left.
- **Type consistency:** `appendBlockAtomic`, `saveRelationshipNote`, `clearCompactionDue` are added to `ProfileDB` in Tasks 4/2/5 and used consistently; block-name set matches the RPC's CHECK and `BLOCK_NAMES`.
- **Risk:** `student_id→user_id` reconciliation skips+logs unresolved rows (Task 6) — verify the unresolved list is acceptable before Task 8's drop.
