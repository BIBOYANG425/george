# Squad Phase 4 — After-Join Coordination

> Final phase of the squad-reimagined system (`bia-roommate/docs/superpowers/specs/2026-06-12-squad-reimagined-design.md`).
> Phases 0 (matching), 1 (为你推荐 board), 2 (george push loop), and 3 (web activity
> hub + receiving controls) are built and merged. Phase 4 adds the after-join
> lifecycle: complete the Phase 3 web→george handoff, remind/RSVP members of a formed
> 局, re-fill drop-outs, and mark 局 complete — all over iMessage, reusing the Phase 2
> proactive-send seam and ping engine.

**Status:** approved 2026-06-15.

**Goal:** Once a 局 has members, george (a) proactively brokers web-expressed interest
into a real join, (b) reminds members to confirm before the deadline, (c) re-pings to
refill a dropped spot, and (d) marks the 局 complete — without burning LLM tokens on the
outbound path and respecting the opt-in spirit (joining a 局 = consent to its logistics).

---

## 1. Scope

**In scope**
- A dedicated **Squad Coordinator** cron in george (`src/jobs/squad-coordinator.ts`):
  template-message, no-LLM, idempotent, time-aware, per-post. Four behaviors:
  web-interest brokering, RSVP reminder, drop-out re-ping, completion.
- A small inbound **`squad_rsvp` tool** + find-people prompt guidance so the orchestrator
  records 来/不来/想加入 replies.
- Wire the proactive-send seam so coordination uses the same Spectrum path as Phase 2.
- One bia-admin migration for coordination state.
- Tests.

**Out of scope (deferred)**
- **Structured event-time** ("remind 2h before 7pm") — Phase 4 reminds relative to the
  post `deadline` (form-by), the only structured time. The Option-B "george pins a
  concrete time/place" model is future work.
- **LLM-voiced coordination messages** — messages are templates (deterministic, in
  george's voice, anti-fabrication-safe). LLM phrasing is a future opt-in.
- **New web surface** — coordination is iMessage-only. The Phase 3 hub already shows
  我的局/已加入; a "confirmed N/M" badge is a small future bia-roommate follow-up.
- **Full time/place negotiation/mediation** between members.
- **NOTIFY fast-path** for sub-minute web-broker latency — documented in §11, not built.

## 2. Architecture — the Squad Coordinator

A scheduled job structured like the existing `src/jobs/heartbeat-scheduler.ts`, but it
iterates over **局 (posts)**, not users, on a **deadline-relative** clock. `node-cron`,
default every 15 min (env `SQUAD_COORDINATION_INTERVAL_CRON`), gated by
`SQUAD_COORDINATION_ENABLED`. It holds no state — Postgres is the source of truth, and
per-row guards make each action fire once per occurrence: one-shot timestamps
(`brokered_at`, `reminder_sent_at`, `completed_at`) for things that happen once, and the
re-settable `needs_refill` flag for refills that can recur as members drop.

**Why a poll, not triggers:** two of the four behaviors (reminder, completion) are
*time-driven* — the passage of time is not a DB event a trigger can fire on — so a
scheduler is required regardless. The two event-driven behaviors (web-broker, re-ping)
*could* be triggers, but the action is an external iMessage send that lives in george's
Node process, not in Postgres; a trigger could only `NOTIFY` george, which still needs a
durable, idempotent, retry-safe processor — i.e. the same poll. One self-healing loop is
less machinery than triggers + a scheduler + a notify/queue bridge. (See §11 for the
optional NOTIFY fast-path.)

**Why no LLM / no token burn:** the Coordinator is a **dumb dispatcher** — a few indexed
`SELECT`s per tick plus **template** iMessage sends (the same templated approach as Phase
2's `composePing`). It never reads or reasons. The only LLM cost in Phase 4 is the
*inbound* reply handled by the normal orchestrator turn (per reply, not per tick).

One tick (`runCoordinatorOnce(deps)`) runs the four behaviors below in order; each is an
independent query → act → stamp.

## 3. Behavior ① — Web-interest brokering (closes the Phase 3 handoff)

Phase 3 records a web `加入` tap as `squad_pings.response='joined'` with **no
`squad_members` row** (iMessage joins write members; web joins do not — that's the
distinguishing signal). The Coordinator finds these and has george reach out.

- **Select:** pings where `response='joined'` AND `brokered_at IS NULL` AND there is **no
  `squad_members` row** for `(post_id, recipient_student_id)` AND the post is still
  joinable (`squad_posts_with_status.status = 'open'`).
- **Act:** resolve handle via `handleFor(recipient_student_id)` (→ `students.imessage_id`);
  `sendProactive(handle, [bubble])` where bubble = template
  `诶 看到你想加入 ${category}局${location?  ' '+location : ''} 想去的话回我一声 我帮你报名哈`.
  **Gating:** bypass `pings_enabled` (they tapped 加入 — explicit interest); skip only if
  no channel (`imessage_id` null) or deep quiet hours.
- **Stamp:** `UPDATE squad_pings SET brokered_at = now()` → fires once, ever.
- **The join itself** happens when they reply "想加入/想去" — the **existing concierge**
  (`join-squad-post`) runs on the inbound message (capacity-checked; `squad_full` P0001 →
  "这个局满了 🥲"). The Coordinator only sends the nudge.

## 4. Behavior ② — RSVP reminder

For a formed 局 approaching its deadline, remind each member to confirm.

- **Select:** posts where `status='open'` or `'full'` (from `squad_posts_with_status`),
  `deadline IS NOT NULL` AND `deadline` is within the reminder window
  (`now() >= deadline - SQUAD_REMINDER_WINDOW_HOURS` AND `deadline > now()`),
  `reminder_sent_at IS NULL`, and the post has ≥1 `squad_members` row.
- **Act:** for each member, `sendProactive(handle, [bubble])` where bubble = template
  `${posterName} 的 ${category}局${location? ' '+location : ''} 还来吗? 回 来/不来 哈`.
  **Gating (joining = consent):** bypass weekly cap + `pings_enabled`; still skip deep
  quiet hours (no 2am) and no-channel members.
- **Stamp:** `UPDATE squad_posts SET reminder_sent_at = now()` → one reminder per 局.
- Posts **without a deadline** get no time-anchored reminder (no clock); they still get
  web-broker + drop-out re-ping.

## 5. Behavior ③ — Drop-out → re-ping

A "不来"/decline reply (handled inbound, §7) **deletes the member row** (the capacity
trigger drops `current_people`) and sets the post's `needs_refill = true`. The Coordinator
consumes that flag and refills.

- **Select:** posts where `status='open'`, `current_people < max_people`, `needs_refill =
  true`, `deadline > now()` (or `deadline` null), `completed_at IS NULL`, `cancelled_at IS
  NULL`. The `needs_refill` flag (set by the drop, §7) is what distinguishes a post that
  *lost* a member from a freshly-created open post (which Phase 2 already pinged) — so the
  Coordinator never cold-fans a brand-new post.
- **Act:** call the **existing** `runPingFanout(postId, deps)` (Phase 2 engine) — these are
  **new candidates = cold pings**, so they respect ALL gates (`pings_enabled`, cap, quiet
  hours, category) exactly as Phase 2 does. The dropped member (and anyone already pinged
  or joined) is naturally excluded: they already have a `squad_pings` row, and the unique
  `(post_id, recipient_student_id)` constraint blocks a re-ping.
- **Stamp:** `UPDATE squad_posts SET needs_refill = false`. A later drop sets it back to
  true, enabling another refill; this also bounds the work to one fanout per reopening.

## 6. Behavior ④ — Completion

- **Select:** posts where `deadline + SQUAD_COMPLETION_GRACE_HOURS < now()`,
  `completed_at IS NULL`, `cancelled_at IS NULL`.
- **Act:** `UPDATE squad_posts SET completed_at = now()`. No message. This removes the 局
  from active coordination (all four selects exclude completed posts).
- Auto-completion only (no organizer action in v1). A manual `完成` command is future work.

## 7. Inbound replies — the `squad_rsvp` tool

The Coordinator only sends. Replies arrive through george's normal inbound iMessage path
(the orchestrator). A new tool lets the orchestrator record them.

- **Tool `squad_rsvp`** (`src/tools/squad-rsvp.ts`, registered + wired into the
  find-people sub-agent): input `{ decision: 'confirm'|'drop'|'join', post_id?, student_id }`.
  - `confirm` → `squad_members.rsvp_status='confirmed', rsvp_at=now()` for (post, me).
  - `drop` → **delete** my member row (reopen the spot; capacity trigger decrements) and
    `UPDATE squad_posts SET needs_refill=true` for that post. Idempotent (no row → no-op).
  - `join` (reply to a web-interest broker nudge) → delegate to the existing
    `join-squad-post` logic.
- **Disambiguation:** when the reply doesn't name a 局, the tool resolves "my open
  coordination item" = the most recent post where I have `rsvp_status='pending'` (reminded)
  or an un-acted brokered ping. Prompt guidance in `prompts/find-people.md` tells the
  concierge to read 来/不来/想加入 against that context and to ask which 局 if ambiguous
  (never guess a post).
- Anti-fabrication + persona unchanged: the concierge names the real 局 from data, never
  invents one; voice rules (no em-dashes, no 不是…而是) apply.

## 8. Gating policy (summary)

| Message | pings_enabled | weekly cap | quiet hours | channel |
|---|---|---|---|---|
| Web-interest broker (§3) | **bypass** (they tapped 加入) | n/a | deep-quiet only | required |
| RSVP reminder (§4) | **bypass** (joined = consent) | **bypass** | deep-quiet only | required |
| Drop-out **re-ping** (§5) | respect | respect | respect | required |

"Deep quiet hours" = a hard floor (e.g. 02:00–08:00 LA) applied to bypassing messages so
coordination is never rude, even when it ignores the user's configured window.

## 9. Schema — one bia-admin migration

`supabase/migrations/<ts>_squad_phase4_coordination.sql` (append-only; applied to prod
`ujkaregrwrppaehvbahf`):

- `squad_members`: `rsvp_status text not null default 'pending'`
  check in `('pending','confirmed')`; `rsvp_at timestamptz`. (A drop deletes the row, so
  there is no `'dropped_out'` state to store — §5/§7.)
- `squad_posts`: `reminder_sent_at timestamptz`; `completed_at timestamptz`;
  `needs_refill boolean not null default false` (set true on a drop, false after a refill).
- `squad_pings`: `brokered_at timestamptz` (web-interest nudge fires once).

All reads by the Coordinator use the **service-role** client (server-side cron), so no new
RLS policies are needed; the matching tables stay deny-all. The `squad_posts_with_status`
view already exposes derived status. Indexes: partial index on
`squad_pings(brokered_at) where brokered_at is null and response='joined'`, and on
`squad_posts(deadline) where completed_at is null` to keep tick scans cheap.

## 10. Proactive-send wiring + config

- **Reuse** the Phase 2 seam exactly: `getActiveSpectrumClient().sendProactive(handle,
  bubbles)` (`src/adapters/spectrum.ts`), handle from `handleFor(studentId)` →
  `students.imessage_id`. The Coordinator deps mirror `squad-ping-deps.ts`
  (lazy-import `getActiveSpectrumClient` to avoid the circular dep; fail-closed on no
  connection — skip and retry next tick).
- **Env:** `SQUAD_COORDINATION_ENABLED` (default false), `SQUAD_COORDINATION_INTERVAL_CRON`
  (default `*/15 * * * *`), `SQUAD_REMINDER_WINDOW_HOURS` (default 24),
  `SQUAD_COMPLETION_GRACE_HOURS` (default 12), `SQUAD_DEEP_QUIET_START/END_HOUR_LA`
  (default 2/8). Documented in `.env.example`.

## 11. Error handling, edge cases, future

- **No Spectrum connection / send failure:** skip that recipient, do NOT stamp → retried
  next tick (at-least-once, self-healing).
- **Stamp before vs after send:** stamp **after** a successful send so a failed send
  retries; accept that a crash between send and stamp could double-send once (rare,
  tolerable for a reminder). Per-post `reminder_sent_at` bounds the blast radius to one
  extra message.
- **Capacity race on a brokered join:** existing `squad_full` (P0001) path.
- **Tick overlap / long tick:** guard with a simple in-process "running" flag (skip a tick
  if the previous is still running), mirroring the heartbeat scheduler.
- **Future:** NOTIFY fast-path (trigger → `pg_notify` → george listener) for instant
  web-broker nudges, with this cron as the durable backstop; structured event-time
  reminders (Option B); a web "confirmed N/M" badge; LLM-voiced messages (opt-in).

## 12. Testing

- **Coordinator unit tests** (pure `runCoordinatorOnce` over injected deps, no network):
  each behavior selects the right rows and acts once; idempotency (a second tick over the
  same state sends nothing); gating (reminder bypasses cap/pings_enabled but not deep
  quiet; re-ping respects all gates); completion excludes the post from later behaviors.
- **`squad_rsvp` tool tests:** confirm/drop/join mutate the right rows; drop reopens the
  spot; ambiguous reply asks which 局.
- **Migration:** column defaults + checks; a deny-all RLS smoke (service-role only).
- Persona/voice tests stay green (template copy has no em-dashes / banned phrases).

## 13. Files & sequencing

**bia-admin (first):** the coordination-state migration (§9) + apply to prod.

**george (second):**
- `src/jobs/squad-coordinator.ts` (the tick + the four behaviors) + `src/jobs/index.ts`
  registration (cron, gated).
- `src/services/squad-coordinator-deps.ts` (select queries + the reused `sendProactive` /
  `runPingFanout` wiring + gating helpers), mirroring `squad-ping-deps.ts`.
- `src/tools/squad-rsvp.ts` + register in `src/tools/index.ts` + wire into
  `src/agent/agents.config.ts` (find-people) + `prompts/find-people.md` guidance.
- `.env.example` config (§10).
- Tests.

**Cross-repo:** the migration lands in bia-admin and applies to prod before the george
cron does anything real. george is on the unmerged integration stack
(`fix/imessage-rapid-fire-abort`); Phase 4 branches off it.
