# Pacing & Delivery v1 — Implementation Plan

> **For agentic workers:** execute task-by-task. Each task is a commit on `feat/pacing-delivery-v1`. CI (`tsc --noEmit` + `vitest run`) gates everything. Default-OFF path must stay byte-identical.

**Goal:** Make texting George feel like texting a person — variable, length-aware inter-bubble timing + restart-durable multi-bubble delivery — borrowing HANA's pacing patterns (not its code).

**Spec:** `docs/superpowers/specs/2026-06-22-pacing-delivery-handoff.md` (self-contained design; read it).

**Architecture:** A pure typing-sim function replaces the fixed 600 ms inter-bubble delay. A durable Supabase-backed outgoing-bubble queue persists bubbles 2..N with `send_at` timestamps; a ~1 s drainer sends due bubbles and survives restarts. All behind `GEORGE_PACING_ENABLED` (default-OFF → today's in-process fixed-delay path, byte-identical).

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Express, `@anthropic-ai/claude-agent-sdk`, Supabase (service-role in `src/db/*`), vitest, DI/seam pattern with in-memory fakes.

## Lead decisions (resolved open questions from the handoff §11)

1. **Flag:** `GEORGE_PACING_ENABLED`, default-OFF. Reversible rollout of a live-send-path + durable-store change.
2. **Activity-driven delay (G4):** OUT of v1. Conflicts with the responsiveness criterion; human-feel comes from cadence + typing realism, not slow answers.
3. **`MAX_PARTS`:** keep 4. Raising to 5 is prompt-coupled; do not collide with the voice/character-card workstream.
4. **Durable store:** NEW `outgoing_bubbles` table. Path-B's `imessage_outgoing` is an ack-polled iPhone-Shortcuts queue with attachment columns; reusing it would entangle Spectrum durable-bubble logic with legacy Path-B semantics.
5. **Typing indicator on scheduled bubbles:** drive from the drainer (it holds the active Spectrum client). Fall back to first-bubble-only if it complicates the abort path; note the tradeoff.

## Constraints (DO-NOT)

- No pg-boss. Single-process server → lightweight Supabase-table + drainer.
- Do not slow the first reply; do not add default "leave on read."
- Preserve the existing debounce / interim-nudge / typing-indicator / abort-carry-forward semantics in `spectrum.ts` + `spectrum-stages.ts`.
- Schema owned by bia-admin (`~/Documents/BIA 新生service/bia-admin/supabase/migrations/`). Write the migration there; DO NOT apply to prod (human-only). Deploy migration-then-code.
- Service-role key only in `src/db/*`. No Haiku (Sonnet for any fast tier; pacing needs no LLM).
- Drainer runs only inside the Spectrum adapter (agent service), never the dashboard service → no double-send.

## Tasks

### Task 1 — `typing-sim.ts` (pure) + tests
- Create `src/adapters/typing-sim.ts`: `typingDelayMs(bubble: string, opts?): number = clamp(ceil(len/CHARS_PER_SEC*1000)+THINK_PAUSE_MS, MIN_MS, MAX_MS)` with bounded ±jitter (jitter injectable/seedable for deterministic tests). Defaults: `CHARS_PER_SEC≈7`, `THINK_PAUSE_MS≈250`, `MIN_MS≈450`, `MAX_MS≈3500`. Also export `totalPacingBudgetMs(bubbles)` clamp so a 4-bubble reply's summed gaps stay ≤ ~8 s.
- Test `tests/adapters/typing-sim.test.ts`: monotonic short<long, clamps at MIN/MAX, jitter bounded, total-budget clamp.

### Task 2 — bia-admin migration `outgoing_bubbles` (written, NOT applied)
- Create `…_outgoing_bubbles.sql` in bia-admin migrations (timestamp > latest). Table: `id uuid pk default gen_random_uuid()`, `user_id_handle text not null`, `content text not null`, `seq int not null`, `send_at timestamptz not null`, `sent_at timestamptz`, `created_at timestamptz default now()`. Indexes: `(send_at) where sent_at is null` (drainer), `(user_id_handle) where sent_at is null` (cancel). RLS: enable, NO anon/authenticated policies (service-role only — mirror existing service-role-only tables). Commit + open PR in bia-admin; do not apply.

### Task 3 — `outgoing-scheduler.ts` (seam + in-memory fake + Supabase impl) + tests
- Create `src/adapters/outgoing-scheduler.ts`: `OutgoingSchedulerDB` interface (`insertBubbles`, `selectDue(now)`, `markSent(id)`, `cancelPending(handle)`), an in-memory fake, and a Supabase impl in `src/db/outgoing-bubbles.ts` (service-role). Scheduler API: `schedule(handle, bubbles, baseDelayFn)` (computes cumulative `send_at` from `typingDelayMs`), `drainDue(now, send)`, `cancelPending(handle)`. Drainer loop is a thin `setInterval` wrapper started/stopped by the adapter.
- Test `tests/adapters/outgoing-scheduler.test.ts` with the fake: schedule N → drainDue sends only due in seq order; cancelPending clears a handle; **restart simulation** (new scheduler instance over same store state still drains pending) — proves G1.

### Task 4 — wire into `spectrum.ts` / `spectrum-stages.ts` behind `GEORGE_PACING_ENABLED`
- In `stageSend` (pacing path): send bubble 1 inline (responsiveness), schedule 2..N via the scheduler with `typingDelayMs`. Start the drainer in `startSpectrumAdapter`, tear down in `stopSpectrumAdapter`. Wire `cancelPending(handle)` into the rapid-fire abort path. Drive typing indicator from the drainer for scheduled bubbles (or first-bubble-only fallback — note it). Default-OFF → unchanged fixed-600 ms in-process loop, byte-identical.
- Tests: bubble 1 inline; 2..N via scheduler; new inbound cancels pending + re-generates. Reuse the spectrum-stages test idiom. OFF path equivalence.

### Task 5 — `.env.example` + tunables + docs
- Add `GEORGE_PACING_ENABLED` (+ `PACING_CHARS_PER_SEC`, `PACING_MIN_BUBBLE_MS`, `PACING_MAX_BUBBLE_MS`, `PACING_THINK_PAUSE_MS`, `PACING_DRAIN_INTERVAL_MS`) to `.env.example`. Short note in CLAUDE.md/AGENT.md pacing section if warranted (coordinate; do not touch master.md). Full `vitest run` + `tsc` green.

## Verification
- Default-OFF + full suite proves zero regression when unset.
- typing-sim + scheduler are pure / fake-backed — unit-testable with no network/LLM.
- Restart-simulation test is the headline durability proof.
