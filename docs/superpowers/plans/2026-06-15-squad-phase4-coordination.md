# Squad Phase 4 — After-Join Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated, no-LLM Squad Coordinator that closes the Phase 3 web→george handoff, reminds members of a formed 局 to RSVP, re-pings to refill drop-outs, and auto-completes 局 — plus the inbound `squad_rsvp` tool for 来/不来/想加入 replies.

**Architecture:** bia-admin ships one migration of coordination columns. george gets a **pure** `runCoordinatorOnce(deps)` engine (4 behaviors, template messages, idempotent stamps), a real-service `squad-coordinator-deps` (SQL selects + the reused Phase 2 `sendProactive`/`runPingFanout` seam), a feature-gated cron, and the `squad_rsvp` tool wired into the find-people sub-agent.

**Tech Stack:** TypeScript (Node 20, ESM), Supabase (`@supabase/supabase-js`), `node-cron`, `zod`, `vitest`, Photon Spectrum.

**Spec:** `docs/superpowers/specs/2026-06-15-squad-phase4-coordination-design.md`

---

## File Structure

**bia-admin** (`~/Documents/BIA 新生service/bia-admin`)
- Create `supabase/migrations/20260615130000_squad_phase4_coordination.sql` — coordination columns + indexes.
- Create `lib/matching/__tests__/phase4.migration.integration.test.ts` — column/default/check verification (gated by `RUN_DB_TESTS`).

**george** (`~/Code/george`)
- Create `src/jobs/squad-coordinator.ts` — pure `runCoordinatorOnce(deps)` + 4 behaviors + templates + `CoordinatorDeps`.
- Create `src/services/squad-coordinator-deps.ts` — real-service deps (SQL selects + Spectrum/`runPingFanout` wiring). Not unit-tested (mirrors `squad-ping-deps.ts`).
- Create `src/tools/squad-rsvp.ts` — the inbound RSVP tool.
- Modify `src/index.ts` — register the gated cron.
- Modify `src/tools/index.ts` — export/import/register `squad_rsvp`.
- Modify `src/agent/agents.config.ts` — add `'squad_rsvp'` to find-people `tools`.
- Modify `prompts/find-people.md` — RSVP-reply disambiguation guidance.
- Modify `.env.example` — coordination env vars.
- Tests: `tests/jobs/squad-coordinator.test.ts`, `tests/tools/squad-rsvp.test.ts`.

---

# PART A — bia-admin (PR 1)

> Work in `~/Documents/BIA 新生service/bia-admin`. **`pnpm install` ONCE** before testing (store lock — never concurrent). DB tests: `RUN_DB_TESTS=true pnpm exec vitest run <file>`.

### Task A1: Coordination migration

**Files:**
- Create: `supabase/migrations/20260615130000_squad_phase4_coordination.sql`

- [ ] **Step 1: Create branch + write the migration**

```bash
cd ~/"Documents/BIA 新生service/bia-admin"
git checkout main && git checkout -b feat/squad-phase4-coordination
```

Write `supabase/migrations/20260615130000_squad_phase4_coordination.sql`:

```sql
-- supabase/migrations/20260615130000_squad_phase4_coordination.sql
-- Squad Phase 4: after-join coordination state. Read/written by george's Squad
-- Coordinator via the service-role client (cron) and the squad_rsvp tool — the
-- matching tables stay deny-all RLS, so no new policies are added here.
-- Spec: george/docs/superpowers/specs/2026-06-15-squad-phase4-coordination-design.md

-- Per-member RSVP. A drop DELETES the member row (capacity trigger decrements),
-- so there is no 'dropped_out' state to store — only pending/confirmed.
alter table public.squad_members
  add column if not exists rsvp_status text not null default 'pending'
    check (rsvp_status in ('pending','confirmed')),
  add column if not exists rsvp_at timestamptz;

-- Per-post coordination flags. reminder_sent_at + completed_at are one-shot;
-- needs_refill is re-settable (true on a drop, false after a refill fanout).
alter table public.squad_posts
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists needs_refill boolean not null default false;

-- Per-ping: the web-interest broker nudge fires once.
alter table public.squad_pings
  add column if not exists brokered_at timestamptz;

-- Keep the Coordinator's per-tick scans cheap.
create index if not exists squad_pings_broker_pending_idx
  on public.squad_pings (recipient_student_id)
  where brokered_at is null and response = 'joined';
create index if not exists squad_posts_active_deadline_idx
  on public.squad_posts (deadline)
  where completed_at is null;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260615130000_squad_phase4_coordination.sql
git commit -m "feat(squad-p4): coordination state migration (rsvp, reminder, completion, refill, broker)"
```

### Task A2: Migration verification test + apply to prod

**Files:**
- Create: `lib/matching/__tests__/phase4.migration.integration.test.ts`

- [ ] **Step 1: Write the test** (mirrors the `RUN_DB_TESTS` harness in `rpc.integration.test.ts`)

```ts
// lib/matching/__tests__/phase4.migration.integration.test.ts
// Run: RUN_DB_TESTS=true pnpm exec vitest run lib/matching/__tests__/phase4.migration.integration.test.ts
// Needs .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";

const RUN = process.env.RUN_DB_TESTS === "true";
const d = describe.skipIf(!RUN);

function env(k: string): string {
  if (process.env[k]) return process.env[k]!;
  for (const p of [".env.local", "bia-admin/.env.local"]) {
    if (!fs.existsSync(p)) continue;
    const line = fs.readFileSync(p, "utf8").split("\n").find((l) => l.startsWith(k + "="));
    if (line) return line.slice(k.length + 1).trim();
  }
  throw new Error(`missing env ${k}`);
}

let admin: SupabaseClient;
const ids = { posts: [] as string[], students: [] as string[] };

beforeAll(() => {
  if (!RUN) return;
  admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
});

afterAll(async () => {
  if (!RUN) return;
  if (ids.posts.length) await admin.from("squad_posts").delete().in("id", ids.posts);
  if (ids.students.length) await admin.from("students").delete().in("id", ids.students);
});

d("squad phase 4 migration", () => {
  it("squad_posts has needs_refill defaulting false + reminder/completed null", async () => {
    const { data, error } = await admin.from("squad_posts").insert({
      poster_name: "p4test", category: "其它", content: "p4 migration test", contact: "x",
      max_people: 4, current_people: 1,
    }).select("id, needs_refill, reminder_sent_at, completed_at").single();
    expect(error).toBeNull();
    ids.posts.push(data!.id);
    expect(data!.needs_refill).toBe(false);
    expect(data!.reminder_sent_at).toBeNull();
    expect(data!.completed_at).toBeNull();
  });

  it("squad_members.rsvp_status defaults 'pending' and rejects an invalid value", async () => {
    const { data: s } = await admin.from("students").insert({ name: "p4member" }).select("id").single();
    ids.students.push(s!.id);
    const { data: post } = await admin.from("squad_posts").insert({
      poster_name: "p4test", category: "其它", content: "p4 member test", contact: "x",
      max_people: 4, current_people: 1,
    }).select("id").single();
    ids.posts.push(post!.id);

    const ok = await admin.from("squad_members")
      .insert({ post_id: post!.id, student_id: s!.id }).select("rsvp_status").single();
    expect(ok.error).toBeNull();
    expect(ok.data!.rsvp_status).toBe("pending");

    const bad = await admin.from("squad_members")
      .update({ rsvp_status: "dropped_out" }).eq("post_id", post!.id).eq("student_id", s!.id);
    expect(bad.error).not.toBeNull(); // CHECK rejects anything outside pending/confirmed
  });
});
```

- [ ] **Step 2: Commit the test**

```bash
git add lib/matching/__tests__/phase4.migration.integration.test.ts
git commit -m "test(squad-p4): migration column/default/check verification"
```

- [ ] **Step 3: PAUSE — get human go-ahead, then apply to prod**

**STOP. Ask Bobby to approve applying the migration to prod `ujkaregrwrppaehvbahf`.** Only after explicit go-ahead, apply via the Supabase MCP `apply_migration` (project `ujkaregrwrppaehvbahf`, name `squad_phase4_coordination`, the file's SQL). Then:

```bash
RUN_DB_TESTS=true pnpm exec vitest run lib/matching/__tests__/phase4.migration.integration.test.ts
```
Expected: 2 tests PASS.

- [ ] **Step 4: Open the bia-admin PR**

```bash
git push -u origin feat/squad-phase4-coordination
gh pr create --base main --title "feat(squad-p4): after-join coordination state migration" \
  --body-file <(printf '%s\n' "Phase 4 coordination columns: squad_members.rsvp_status/rsvp_at, squad_posts.reminder_sent_at/completed_at/needs_refill, squad_pings.brokered_at + scan indexes. No new RLS (Coordinator uses service-role). Applied to prod ujkaregrwrppaehvbahf; column/default/check tests green." "" "Companion: george feat/squad-phase4-coordination." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
```

---

# PART B — george (PR 2)

> Work in `~/Code/george` on branch `feat/squad-phase4-coordination` (already created off the integration tip). Part A's migration must be applied to prod before the cron does real work. Tests: `npx vitest run <file>`.

### Task B1: The pure Coordinator engine

**Files:**
- Create: `src/jobs/squad-coordinator.ts`
- Test: `tests/jobs/squad-coordinator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/jobs/squad-coordinator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runCoordinatorOnce, type CoordinatorDeps } from '../../src/jobs/squad-coordinator.js'

function deps(over: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    selectWebInterest: async () => [],
    selectReminders: async () => [],
    selectRefills: async () => [],
    selectCompletions: async () => [],
    handleFor: async () => 'h',
    sendProactive: vi.fn(async () => {}),
    runFanout: vi.fn(async () => {}),
    markBrokered: vi.fn(async () => {}),
    markReminderSent: vi.fn(async () => {}),
    clearNeedsRefill: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    nowHourLA: () => 14, // daytime, not deep-quiet
    deepQuiet: { start: 2, end: 8 },
    ...over,
  }
}

describe('runCoordinatorOnce', () => {
  it('① brokers a web-interest ping once, then stamps brokered_at', async () => {
    const send = vi.fn(async () => {})
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: 'K-town' }],
      sendProactive: send, markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0][1])).toContain('帮你报名')
    expect(markBrokered).toHaveBeenCalledWith('pg1')
  })

  it('② reminds every member of a post, then stamps the post once', async () => {
    const send = vi.fn(async () => {})
    const markReminderSent = vi.fn(async () => {})
    const d = deps({
      selectReminders: async () => [{ post_id: 'po1', poster_name: '学长', category: '自习', location: 'Leavey', member_student_ids: ['a', 'b'] }],
      sendProactive: send, markReminderSent,
    })
    await runCoordinatorOnce(d)
    expect(send).toHaveBeenCalledTimes(2)
    expect(String(send.mock.calls[0][1])).toContain('还来吗')
    expect(markReminderSent).toHaveBeenCalledWith('po1')
  })

  it('③ refills a dropped post via runFanout then clears needs_refill', async () => {
    const runFanout = vi.fn(async () => {})
    const clearNeedsRefill = vi.fn(async () => {})
    const d = deps({ selectRefills: async () => ['po2'], runFanout, clearNeedsRefill })
    await runCoordinatorOnce(d)
    expect(runFanout).toHaveBeenCalledWith('po2')
    expect(clearNeedsRefill).toHaveBeenCalledWith('po2')
  })

  it('④ marks an expired post completed', async () => {
    const markCompleted = vi.fn(async () => {})
    const d = deps({ selectCompletions: async () => ['po3'], markCompleted })
    await runCoordinatorOnce(d)
    expect(markCompleted).toHaveBeenCalledWith('po3')
  })

  it('skips broker/reminder sends in deep-quiet hours and does NOT stamp', async () => {
    const send = vi.fn(async () => {})
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      nowHourLA: () => 3, // inside 2-8 deep quiet
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: null }],
      sendProactive: send, markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(send).not.toHaveBeenCalled()
    expect(markBrokered).not.toHaveBeenCalled()
  })

  it('does NOT stamp when the send fails (retried next tick)', async () => {
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: null }],
      sendProactive: async () => { throw new Error('no_spectrum_connection') },
      markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(markBrokered).not.toHaveBeenCalled()
  })

  it('skips a recipient with no channel (handleFor null) without stamping', async () => {
    const send = vi.fn(async () => {})
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      handleFor: async () => null,
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: null }],
      sendProactive: send, markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(send).not.toHaveBeenCalled()
    expect(markBrokered).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/jobs/squad-coordinator.test.ts`
Expected: FAIL ("Cannot find module ../../src/jobs/squad-coordinator.js").

- [ ] **Step 3: Implement `src/jobs/squad-coordinator.ts`**

```ts
// src/jobs/squad-coordinator.ts
// Pure after-join coordination engine (spec 2026-06-15-squad-phase4). Four
// behaviors over injected deps: ① broker web-expressed interest, ② RSVP reminder,
// ③ refill a dropped spot (reuses the Phase 2 ping fanout), ④ auto-complete.
// Template messages only — NO LLM on this path. Idempotent: one-shot stamps
// (brokered_at/reminder_sent_at/completed_at) + the re-settable needs_refill.
// At-least-once: stamp ONLY after a successful send (a failed send retries next
// tick). Gating is split — broker/reminder bypass cap+pings_enabled (joining =
// consent) and apply only a deep-quiet floor here; refill goes through runFanout,
// which applies ALL cold-ping gates.

export interface WebInterestRow {
  ping_id: string
  recipient_student_id: string
  category: string
  location: string | null
}
export interface ReminderRow {
  post_id: string
  poster_name: string
  category: string
  location: string | null
  member_student_ids: string[]
}

export interface CoordinatorDeps {
  // selectors
  selectWebInterest: () => Promise<WebInterestRow[]>
  selectReminders: () => Promise<ReminderRow[]>
  selectRefills: () => Promise<string[]>      // post_ids needing refill
  selectCompletions: () => Promise<string[]>  // post_ids past deadline+grace
  // actions
  handleFor: (studentId: string) => Promise<string | null>
  sendProactive: (handle: string, bubbles: string[]) => Promise<void>
  runFanout: (postId: string) => Promise<void>
  // stamps
  markBrokered: (pingId: string) => Promise<void>
  markReminderSent: (postId: string) => Promise<void>
  clearNeedsRefill: (postId: string) => Promise<void>
  markCompleted: (postId: string) => Promise<void>
  // helpers
  nowHourLA: () => number
  deepQuiet: { start: number; end: number }
}

// Deep-quiet floor: a hard window (default 02:00-08:00 LA) applied to messages
// that otherwise bypass the user's configured quiet hours, so coordination is
// never rude. Same wrap logic as inQuietHours in the ping engine.
export function inDeepQuiet(hour: number, q: { start: number; end: number }): boolean {
  return q.start <= q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end
}

const loc = (l: string | null) => (l ? ` ${l}` : '')

export function brokerBubble(category: string, location: string | null): string {
  return `诶 看到你想加入${category}局${loc(location)} 想去的话回我一声 我帮你报名哈`
}
export function reminderBubble(posterName: string, category: string, location: string | null): string {
  return `${posterName} 的${category}局${loc(location)} 还来吗? 回 来/不来 哈`
}

async function brokerWebInterest(deps: CoordinatorDeps): Promise<void> {
  if (inDeepQuiet(deps.nowHourLA(), deps.deepQuiet)) return
  for (const r of await deps.selectWebInterest()) {
    const handle = await deps.handleFor(r.recipient_student_id)
    if (!handle) continue
    try {
      await deps.sendProactive(handle, [brokerBubble(r.category, r.location)])
      await deps.markBrokered(r.ping_id) // stamp ONLY after a successful send
    } catch {
      // no connection / send failed — leave brokered_at null, retried next tick
    }
  }
}

async function sendReminders(deps: CoordinatorDeps): Promise<void> {
  if (inDeepQuiet(deps.nowHourLA(), deps.deepQuiet)) return
  for (const p of await deps.selectReminders()) {
    let anySent = false
    for (const sid of p.member_student_ids) {
      const handle = await deps.handleFor(sid)
      if (!handle) continue
      try {
        await deps.sendProactive(handle, [reminderBubble(p.poster_name, p.category, p.location)])
        anySent = true
      } catch {
        // skip this member, retried next tick (the post stays un-stamped if nobody was reached)
      }
    }
    if (anySent) await deps.markReminderSent(p.post_id) // one reminder per post
  }
}

async function refillDropouts(deps: CoordinatorDeps): Promise<void> {
  for (const postId of await deps.selectRefills()) {
    try {
      await deps.runFanout(postId) // cold pings — runFanout applies ALL gates
      await deps.clearNeedsRefill(postId)
    } catch {
      // leave needs_refill true, retried next tick
    }
  }
}

async function completeExpired(deps: CoordinatorDeps): Promise<void> {
  for (const postId of await deps.selectCompletions()) {
    await deps.markCompleted(postId)
  }
}

export async function runCoordinatorOnce(deps: CoordinatorDeps): Promise<void> {
  await brokerWebInterest(deps)
  await sendReminders(deps)
  await refillDropouts(deps)
  await completeExpired(deps)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/jobs/squad-coordinator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify persona/voice lint stays green** (template copy must not trip `voiceLint`)

Run: `npx vitest run tests/tools/bia-lore.test.ts`
Expected: PASS (no em-dashes / banned phrases introduced).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/squad-coordinator.ts tests/jobs/squad-coordinator.test.ts
git commit -m "feat(squad-p4): pure Coordinator engine — broker/remind/refill/complete (no LLM)"
```

### Task B2: Real-service Coordinator deps

**Files:**
- Create: `src/services/squad-coordinator-deps.ts`

> Mirrors `src/services/squad-ping-deps.ts` — thin Supabase + Spectrum glue, not unit-tested here (the engine's invariants are covered by Task B1; this file is verified by integration/E2E). Reuses `triggerPingFanout` and the lazy-import `getActiveSpectrumClient` seam.

- [ ] **Step 1: Implement**

```ts
// src/services/squad-coordinator-deps.ts
// Real-service wiring for the Squad Coordinator engine. The four select queries
// over Supabase + the reused Phase 2 proactive seam (getActiveSpectrumClient)
// and ping fanout (triggerPingFanout). Service-role client (server-side cron);
// the matching tables stay deny-all RLS.
import { supabase } from '../db/client.js'
import { triggerPingFanout } from './squad-ping-deps.js'
import type { CoordinatorDeps, WebInterestRow, ReminderRow } from '../jobs/squad-coordinator.js'

function nowHourLA(): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  return parseInt(fmt.format(new Date()), 10)
}

const num = (v: string | undefined, d: number) => {
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : d
}

export function buildCoordinatorDeps(): CoordinatorDeps {
  const reminderWindowH = num(process.env.SQUAD_REMINDER_WINDOW_HOURS, 24)
  const completionGraceH = num(process.env.SQUAD_COMPLETION_GRACE_HOURS, 12)
  const deepQuiet = {
    start: num(process.env.SQUAD_DEEP_QUIET_START_HOUR_LA, 2),
    end: num(process.env.SQUAD_DEEP_QUIET_END_HOUR_LA, 8),
  }

  return {
    // ① web-expressed interest: response='joined' pings with no member row + not yet brokered + post still open.
    selectWebInterest: async (): Promise<WebInterestRow[]> => {
      const { data, error } = await supabase
        .from('squad_pings')
        .select('id, recipient_student_id, squad_posts_with_status!inner(category, location, status), ' +
                'squad_members!left(student_id)')
        .eq('response', 'joined')
        .is('brokered_at', null)
      if (error || !data) return []
      // Keep only pings whose post is still 'open' AND the recipient is NOT already a member.
      const rows: WebInterestRow[] = []
      for (const r of data as unknown as Array<{
        id: string; recipient_student_id: string
        squad_posts_with_status: { category: string | null; location: string | null; status: string } | null
        squad_members: Array<{ student_id: string | null }>
      }>) {
        const post = r.squad_posts_with_status
        if (!post || post.status !== 'open') continue
        if ((r.squad_members ?? []).some((m) => m.student_id === r.recipient_student_id)) continue
        rows.push({ ping_id: r.id, recipient_student_id: r.recipient_student_id, category: post.category ?? '活动', location: post.location })
      }
      return rows
    },

    // ② RSVP reminder: open/full posts with a deadline in the window, not yet reminded, with ≥1 member.
    selectReminders: async (): Promise<ReminderRow[]> => {
      const nowMs = Date.now()
      const windowStart = new Date(nowMs).toISOString()
      const windowEnd = new Date(nowMs + reminderWindowH * 3600_000).toISOString()
      const { data, error } = await supabase
        .from('squad_posts_with_status')
        .select('id, poster_name, category, location, status, deadline, reminder_sent_at, ' +
                'squad_members(student_id)')
        .is('reminder_sent_at', null)
        .not('deadline', 'is', null)
        .gt('deadline', windowStart)
        .lte('deadline', windowEnd)
      if (error || !data) return []
      const rows: ReminderRow[] = []
      for (const p of data as unknown as Array<{
        id: string; poster_name: string | null; category: string | null; location: string | null; status: string
        squad_members: Array<{ student_id: string | null }>
      }>) {
        if (p.status !== 'open' && p.status !== 'full') continue
        const members = (p.squad_members ?? []).map((m) => m.student_id).filter((s): s is string => !!s)
        if (members.length === 0) continue
        rows.push({ post_id: p.id, poster_name: p.poster_name ?? '学长', category: p.category ?? '活动', location: p.location, member_student_ids: members })
      }
      return rows
    },

    // ③ refill: open posts flagged needs_refill with room and a future (or no) deadline.
    selectRefills: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('squad_posts_with_status')
        .select('id, status, current_people, max_people, deadline, needs_refill, completed_at, cancelled_at')
        .eq('needs_refill', true)
        .is('completed_at', null)
        .is('cancelled_at', null)
      if (error || !data) return []
      const now = Date.now()
      return (data as unknown as Array<{
        id: string; status: string; current_people: number; max_people: number; deadline: string | null
      }>)
        .filter((p) => p.status === 'open' && p.current_people < p.max_people && (!p.deadline || new Date(p.deadline).getTime() > now))
        .map((p) => p.id)
    },

    // ④ completion: past deadline + grace, not completed/cancelled.
    selectCompletions: async (): Promise<string[]> => {
      const cutoff = new Date(Date.now() - completionGraceH * 3600_000).toISOString()
      const { data, error } = await supabase
        .from('squad_posts')
        .select('id, deadline, completed_at, cancelled_at')
        .is('completed_at', null)
        .is('cancelled_at', null)
        .not('deadline', 'is', null)
        .lt('deadline', cutoff)
      if (error || !data) return []
      return (data as Array<{ id: string }>).map((p) => p.id)
    },

    handleFor: async (studentId: string): Promise<string | null> => {
      const { data, error } = await supabase.from('students').select('imessage_id').eq('id', studentId).single()
      if (error || !data) return null
      return (data as { imessage_id: string | null }).imessage_id ?? null
    },

    sendProactive: async (handle: string, bubbles: string[]): Promise<void> => {
      const { getActiveSpectrumClient } = await import('../adapters/spectrum.js')
      const c = getActiveSpectrumClient()
      if (!c) throw new Error('no_spectrum_connection')
      await c.sendProactive(handle, bubbles)
    },

    runFanout: async (postId: string): Promise<void> => { await triggerPingFanout(postId) },

    markBrokered: async (pingId: string): Promise<void> => {
      await supabase.from('squad_pings').update({ brokered_at: new Date().toISOString() }).eq('id', pingId)
    },
    markReminderSent: async (postId: string): Promise<void> => {
      await supabase.from('squad_posts').update({ reminder_sent_at: new Date().toISOString() }).eq('id', postId)
    },
    clearNeedsRefill: async (postId: string): Promise<void> => {
      await supabase.from('squad_posts').update({ needs_refill: false }).eq('id', postId)
    },
    markCompleted: async (postId: string): Promise<void> => {
      await supabase.from('squad_posts').update({ completed_at: new Date().toISOString() }).eq('id', postId)
    },

    nowHourLA,
    deepQuiet,
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "squad-coordinator" || echo "no tsc errors in coordinator files"`
Expected: no errors. (If the embedded-select shapes fight the supabase-js types, cast through `unknown` as shown — the engine tests already pin the row contracts.)

- [ ] **Step 3: Commit**

```bash
git add src/services/squad-coordinator-deps.ts
git commit -m "feat(squad-p4): real-service Coordinator deps (selects + reused Spectrum/fanout seam)"
```

### Task B3: Register the gated cron

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read `src/index.ts`** to find where `startHeartbeatScheduler` is invoked (the existing cron registration site) and the env/config import style.

- [ ] **Step 2: Add the gated Coordinator cron** next to the heartbeat scheduler registration. Insert:

```ts
// Squad Coordinator (Phase 4): after-join coordination. Off by default; reuses
// the Spectrum proactive seam. A running-flag skips a tick if the previous is
// still in flight (ticks are cheap but a slow DB shouldn't stack them).
if (process.env.SQUAD_COORDINATION_ENABLED === 'true') {
  const cron = (await import('node-cron')).default
  const { runCoordinatorOnce } = await import('./jobs/squad-coordinator.js')
  const { buildCoordinatorDeps } = await import('./services/squad-coordinator-deps.js')
  const interval = process.env.SQUAD_COORDINATION_INTERVAL_CRON || '*/15 * * * *'
  let running = false
  cron.schedule(interval, async () => {
    if (running) { console.log('[squad-coordinator] previous tick still running, skipping'); return }
    running = true
    const t0 = Date.now()
    try {
      await runCoordinatorOnce(buildCoordinatorDeps())
      console.log(`[squad-coordinator] tick complete in ${Date.now() - t0}ms`)
    } catch (err) {
      console.error('[squad-coordinator] tick failed:', err)
    } finally {
      running = false
    }
  })
  console.log(`[squad-coordinator] enabled (${interval})`)
}
```

(If `src/index.ts`'s top level is not already `async`/ESM-top-level-await capable, match the file's existing dynamic-import/registration style — the heartbeat scheduler block shows the convention.)

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit 2>&1 | grep -E "src/index" || echo "no tsc errors in index.ts"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(squad-p4): register gated Squad Coordinator cron (running-flag, off by default)"
```

### Task B4: The `squad_rsvp` tool

**Files:**
- Create: `src/tools/squad-rsvp.ts`
- Modify: `src/tools/index.ts`, `src/agent/agents.config.ts`, `prompts/find-people.md`
- Test: `tests/tools/squad-rsvp.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `tests/tools/join-squad-post.test.ts` mocking style — `vi.doMock` the supabase client)

```ts
// tests/tools/squad-rsvp.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
beforeEach(() => { vi.resetModules() })

// A tiny chainable supabase stub: records the last update/delete payload.
function mockDb() {
  const calls: { table: string; op: string; payload?: unknown; eq: Record<string, unknown> }[] = []
  const chain = (table: string, op: string, payload?: unknown) => {
    const c: Record<string, unknown> = {}
    const rec: { table: string; op: string; payload?: unknown; eq: Record<string, unknown> } = { table, op, payload, eq: {} }
    calls.push(rec)
    c.eq = (k: string, v: unknown) => { rec.eq[k] = v; return c }
    c.select = () => c
    c.single = async () => ({ data: null, error: null })
    ;(c as { then?: unknown }).then = (res: (v: { error: null }) => void) => res({ error: null })
    return c
  }
  const from = (table: string) => ({
    update: (payload: unknown) => chain(table, 'update', payload),
    delete: () => chain(table, 'delete'),
  })
  return { client: { from }, calls }
}

describe('squad_rsvp', () => {
  it('confirm sets rsvp_status=confirmed for (post, me)', async () => {
    const { client, calls } = mockDb()
    vi.doMock('../../src/db/client.js', () => ({ supabase: client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'confirm', post_id: 'po1', student_id: 'stu-1' }))
    expect(out.ok).toBe(true)
    const upd = calls.find((c) => c.table === 'squad_members' && c.op === 'update')
    expect((upd!.payload as { rsvp_status: string }).rsvp_status).toBe('confirmed')
    expect(upd!.eq).toMatchObject({ post_id: 'po1', student_id: 'stu-1' })
  })

  it('drop deletes my member row and flags the post needs_refill', async () => {
    const { client, calls } = mockDb()
    vi.doMock('../../src/db/client.js', () => ({ supabase: client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'drop', post_id: 'po1', student_id: 'stu-1' }))
    expect(out.ok).toBe(true)
    expect(calls.some((c) => c.table === 'squad_members' && c.op === 'delete')).toBe(true)
    const flag = calls.find((c) => c.table === 'squad_posts' && c.op === 'update')
    expect((flag!.payload as { needs_refill: boolean }).needs_refill).toBe(true)
  })

  it('join delegates to join_squad_post', async () => {
    const join = vi.fn(async () => JSON.stringify({ ok: true, poster_name: 'X', contact: 'y' }))
    vi.doMock('../../src/db/client.js', () => ({ supabase: mockDb().client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    vi.doMock('../../src/tools/join-squad-post.js', () => ({ joinSquadPostHandler: join }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'join', post_id: 'po1', student_id: 'stu-1' }))
    expect(join).toHaveBeenCalledWith({ post_id: 'po1', student_id: 'stu-1' })
    expect(out.ok).toBe(true)
  })

  it('returns an error when post_id is missing for confirm/drop', async () => {
    vi.doMock('../../src/db/client.js', () => ({ supabase: mockDb().client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'confirm', student_id: 'stu-1' }))
    expect(out.error).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools/squad-rsvp.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/tools/squad-rsvp.ts`**

```ts
// src/tools/squad-rsvp.ts
// Inbound coordination replies (Phase 4). The Coordinator sends; this tool
// records what the member replies over iMessage:
//   confirm → squad_members.rsvp_status='confirmed'
//   drop    → delete my member row (capacity trigger decrements) + post.needs_refill=true
//   join    → delegate to join_squad_post (reply to a web-interest broker nudge)
// {error}-never-throw, mirroring join-squad-post.ts.
import { z } from 'zod'
import { supabase } from '../db/client.js'
import { resolveStudentId } from '../db/students.js'
import { wrapTool } from './_wrap.js'
import { joinSquadPostHandler } from './join-squad-post.js'

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
async function toStudentUuid(raw: string): Promise<string> {
  if (UUID_RX.test(raw)) return raw
  return resolveStudentId(raw, 'imessage')
}

const inputSchema = {
  decision: z.enum(['confirm', 'drop', 'join']).describe('confirm = 来/还在, drop = 不来/退出, join = 想加入 (reply to a broker nudge)'),
  post_id: z.string().describe('UUID of the 局 the reply is about'),
  student_id: z.string().optional().describe('The student UUID injected from context'),
}

export async function squadRsvpHandler(input: {
  decision: 'confirm' | 'drop' | 'join'
  post_id?: string
  student_id?: string
}): Promise<string> {
  try {
    if (!input.post_id) return JSON.stringify({ error: 'post_id required' })
    const rawId = input.student_id ?? ''
    const studentId = rawId ? await toStudentUuid(rawId) : ''
    if (!studentId) return JSON.stringify({ error: 'student_id required' })

    if (input.decision === 'join') {
      // Reply to the web-interest broker nudge — the existing join path handles
      // capacity (squad_full) and marks the ping responded.
      return await joinSquadPostHandler({ post_id: input.post_id, student_id: studentId })
    }

    if (input.decision === 'confirm') {
      const { error } = await supabase
        .from('squad_members')
        .update({ rsvp_status: 'confirmed', rsvp_at: new Date().toISOString() })
        .eq('post_id', input.post_id)
        .eq('student_id', studentId)
      if (error) return JSON.stringify({ error: error.message })
      return JSON.stringify({ ok: true, rsvp: 'confirmed' })
    }

    // drop: free the spot (capacity trigger decrements current_people) and flag refill.
    const { error: delErr } = await supabase
      .from('squad_members')
      .delete()
      .eq('post_id', input.post_id)
      .eq('student_id', studentId)
    if (delErr) return JSON.stringify({ error: delErr.message })
    await supabase.from('squad_posts').update({ needs_refill: true }).eq('id', input.post_id)
    return JSON.stringify({ ok: true, rsvp: 'dropped' })
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message ?? 'unknown error' })
  }
}

export const squadRsvpTool = wrapTool({
  name: 'squad_rsvp',
  description:
    'Record a member reply to a 局 coordination message: confirm (来/还在), drop (不来/退出 — frees the spot), or join (想加入 — completes a web-expressed interest). ' +
    'Input: { decision, post_id, student_id }. Use ONLY when the user clearly answers about a specific 局; if which 局 is ambiguous, ask first — never guess a post.',
  schema: inputSchema,
  handler: squadRsvpHandler,
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/squad-rsvp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the tool in `src/tools/index.ts`** (mirror `join_squad_post` at lines 3 / 35 / 68). Add:
  - near the other `export {` lines: `export { squadRsvpTool } from './squad-rsvp.js'`
  - near the other `import {` lines: `import { squadRsvpTool } from './squad-rsvp.js'`
  - in the `ALL_TOOLS` map (next to `join_squad_post: joinSquadPostTool,`): `squad_rsvp: squadRsvpTool,`

- [ ] **Step 6: Wire into the find-people sub-agent** in `src/agent/agents.config.ts` — add `'squad_rsvp'` to the `find-people` `tools` array (currently `['lookup_student', 'update_profile', 'suggest_connection', 'create_squad_post', 'find_squad_posts', 'join_squad_post']`):

```ts
    tools: ['lookup_student', 'update_profile', 'suggest_connection', 'create_squad_post', 'find_squad_posts', 'join_squad_post', 'squad_rsvp'],
```

- [ ] **Step 7: Add disambiguation guidance to `prompts/find-people.md`** (append a short paragraph; keep george's voice, no em-dashes):

```md
## 局 协调回复 (RSVP)

George 给已经加入的人发过提醒 ("还来吗? 回 来/不来"), 也会主动找在网页上点了加入的人。当有人回复某个局的去留时, 用 `squad_rsvp`:
- "来 / 还在 / 没问题" → decision: confirm
- "不来 / 去不了 / 退出" → decision: drop (这会把名额放出来)
- "想加入 / 帮我报名" (回应主动私信) → decision: join

哪个局不清楚就先问一句, 别瞎猜。说的是用户当前在聊或最近被提醒的那个局。绝不编造不存在的局。
```

- [ ] **Step 8: Typecheck + full squad test pass**

Run: `npx tsc --noEmit 2>&1 | grep -E "squad-rsvp|tools/index|agents.config" || echo "no tsc errors"`
Run: `npx vitest run tests/tools/squad-rsvp.test.ts tests/jobs/squad-coordinator.test.ts tests/tools/bia-lore.test.ts`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tools/squad-rsvp.ts src/tools/index.ts src/agent/agents.config.ts prompts/find-people.md tests/tools/squad-rsvp.test.ts
git commit -m "feat(squad-p4): squad_rsvp tool (confirm/drop/join) + find-people wiring"
```

### Task B5: Env vars + full suite + PR

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the env vars** — append to `.env.example`:

```bash
# ─── Squad Phase 4 — after-join coordination ─────────────────────────
# [agent] The Squad Coordinator cron (broker web-interest, RSVP reminders,
# drop-out re-ping, auto-complete). OFF by default. Template messages only — no
# LLM, no extra key. Needs the bia-admin Phase 4 migration applied.
SQUAD_COORDINATION_ENABLED=false
SQUAD_COORDINATION_INTERVAL_CRON=*/15 * * * *
SQUAD_REMINDER_WINDOW_HOURS=24
SQUAD_COMPLETION_GRACE_HOURS=12
# Deep-quiet floor (LA hours) applied to messages that bypass the user's own
# quiet hours, so coordination is never sent at 3am.
SQUAD_DEEP_QUIET_START_HOUR_LA=2
SQUAD_DEEP_QUIET_END_HOUR_LA=8
```

- [ ] **Step 2: Run the full george suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all green (Phase 4 tests + the existing suite, persona/voice included).

- [ ] **Step 3: Commit + open the PR**

```bash
git add .env.example
git commit -m "chore(squad-p4): document SQUAD_COORDINATION_* env vars"
git push -u origin feat/squad-phase4-coordination
gh pr create --base fix/imessage-rapid-fire-abort --title "feat(squad-p4): after-join coordination (Coordinator cron + squad_rsvp)" \
  --body-file <(printf '%s\n' "Phase 4 after-join coordination. A no-LLM Squad Coordinator cron (broker web-expressed interest, RSVP reminders, drop-out re-ping via runFanout, auto-complete) reusing the Phase 2 Spectrum seam; idempotent stamps; joining=consent gating with a deep-quiet floor; refills stay cold pings. New squad_rsvp tool records 来/不来/想加入 replies in the find-people sub-agent. OFF by default (SQUAD_COORDINATION_ENABLED). Depends on bia-admin Phase 4 migration (applied to prod)." "" "Base is the integration tip fix/imessage-rapid-fire-abort (george stack is unmerged)." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
```

> **Base branch note:** george's stack is unmerged; this PR bases on `fix/imessage-rapid-fire-abort` (the integration tip with Phase 2). Confirm the target with Bobby before pushing if unsure.

---

## Self-Review

**1. Spec coverage:**
- ① web-interest brokering → B1 `brokerWebInterest` + B2 `selectWebInterest`/`markBrokered` + B4 `squad_rsvp` join path. ✓
- ② RSVP reminder → B1 `sendReminders` + B2 `selectReminders`/`markReminderSent`. ✓
- ③ drop-out re-ping → B4 drop (delete + `needs_refill=true`) + B1 `refillDropouts` + B2 `selectRefills`/`runFanout`/`clearNeedsRefill`. ✓
- ④ completion → B1 `completeExpired` + B2 `selectCompletions`/`markCompleted`. ✓
- Inbound `squad_rsvp` + find-people wiring + prompt → B4. ✓
- Gating (joining=consent, deep-quiet floor, refill=cold via runFanout) → B1 (`inDeepQuiet`, no pref checks on broker/reminder) + reuse of `runPingFanout` (all gates). ✓
- Idempotency (one-shot stamps + needs_refill; stamp after success) → B1 + tests. ✓
- Schema → A1. Migration test + prod apply (paused) → A2. ✓
- Config/env → B5. Cron gating + running-flag → B3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected results. The one judgment note is the supabase-js embedded-select typing in B2 (cast through `unknown`, shown explicitly) — not a placeholder.

**3. Type consistency:** `CoordinatorDeps` / `WebInterestRow` / `ReminderRow` are defined in B1 and imported by B2; the deps method names (`selectWebInterest`, `selectReminders`, `selectRefills`, `selectCompletions`, `handleFor`, `sendProactive`, `runFanout`, `markBrokered`, `markReminderSent`, `clearNeedsRefill`, `markCompleted`, `nowHourLA`, `deepQuiet`) match exactly between the engine, the deps, and the tests. `squadRsvpHandler` signature matches its test + the `join_squad_post` delegation shape. Tool registration names (`squad_rsvp`/`squadRsvpTool`) are consistent across `index.ts` and `agents.config.ts`.
