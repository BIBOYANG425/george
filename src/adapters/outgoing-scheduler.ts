/**
 * Restart-durable outgoing-bubble scheduler.
 *
 * Background: George replies in bursts of N bubbles. Bubble 0 is sent INLINE by
 * the caller for responsiveness; bubbles 1..N-1 must land later, paced like a
 * person typing. If we slept in-process between bubbles, a container restart mid
 * burst would silently drop the tail. This module instead PERSISTS bubbles 1..N-1
 * with computed `send_at` timestamps and relies on a drainer that re-reads the
 * store every tick — so the tail survives a restart.
 *
 * Layering:
 *  - OutgoingSchedulerDB is the storage seam (interface). Two impls exist: the
 *    in-memory fake here (tests + a "restart" = a fresh scheduler over the same
 *    db), and the Supabase one in src/db/outgoing-bubbles.ts (service-role only).
 *  - createOutgoingScheduler wraps a db with the pacing/drain/cancel logic. All
 *    testable behaviour lives here, NOT in startDrainer.
 *  - Pacing gaps come from pacedDelays() in typing-sim.ts — reused, never
 *    recomputed (it already clamps the total to MAX_TOTAL_MS).
 *
 * Epoch-ms is the seam currency: every timestamp crossing OutgoingSchedulerDB is
 * a number (ms since epoch). The Supabase impl converts to/from ISO timestamptz.
 *
 * NOT wired into spectrum.ts — that is Task 4.
 *
 * Header last reviewed: 2026-06-24
 */

import { pacedDelays, type TypingSimOpts } from './typing-sim.js'

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/**
 * One persisted outgoing bubble. Mirrors the `outgoing_bubbles` table but uses
 * epoch-ms numbers for the time columns; the Supabase impl converts to/from
 * ISO timestamptz at the boundary.
 *  - seq: 1..N-1 within the burst (bubble 0 is never persisted).
 *  - sentAt: null = still pending.
 */
export interface OutgoingBubbleRow {
  id: string
  handle: string
  content: string
  seq: number
  sendAt: number
  sentAt: number | null
}

/**
 * Storage seam for the scheduler. Implemented by the in-memory fake (tests) and
 * the service-role Supabase client (src/db/outgoing-bubbles.ts).
 */
export interface OutgoingSchedulerDB {
  /** Append pending bubbles (sentAt starts null; id/created_at assigned by the store). */
  insertBubbles(
    rows: Array<{ handle: string; content: string; seq: number; sendAt: number }>,
  ): Promise<void>
  /** Pending rows due now: sentAt IS null AND sendAt <= nowMs, ordered by sendAt asc. */
  selectDue(nowMs: number, limit?: number): Promise<OutgoingBubbleRow[]>
  /** Flip a row to sent at the given epoch-ms. */
  markSent(id: string, sentAtMs: number): Promise<void>
  /** Delete still-pending rows for a handle; return the count deleted. */
  cancelPending(handle: string): Promise<number>
}

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

/**
 * Deterministic in-memory OutgoingSchedulerDB for tests.
 *
 * - ids come from a monotonic counter (NOT Math.random / crypto) so test
 *   assertions are stable.
 * - `_rows()` exposes a snapshot copy of the backing array for assertions.
 * - Because the backing array lives in the closure, constructing a NEW scheduler
 *   over the SAME db instance simulates a process restart sharing one store.
 */
export function createInMemoryOutgoingSchedulerDB(
  seed?: OutgoingBubbleRow[],
): OutgoingSchedulerDB & { _rows(): OutgoingBubbleRow[] } {
  const rows: OutgoingBubbleRow[] = seed ? seed.map((r) => ({ ...r })) : []
  let counter = rows.length

  function nextId(): string {
    counter += 1
    return `mem-${counter}`
  }

  return {
    async insertBubbles(toInsert) {
      for (const r of toInsert) {
        rows.push({
          id: nextId(),
          handle: r.handle,
          content: r.content,
          seq: r.seq,
          sendAt: r.sendAt,
          sentAt: null,
        })
      }
    },
    async selectDue(nowMs, limit) {
      const due = rows
        .filter((r) => r.sentAt === null && r.sendAt <= nowMs)
        .sort((a, b) => a.sendAt - b.sendAt)
      const capped = limit !== undefined ? due.slice(0, limit) : due
      // Hand back copies so callers can't mutate the store through the snapshot.
      return capped.map((r) => ({ ...r }))
    },
    async markSent(id, sentAtMs) {
      const row = rows.find((r) => r.id === id)
      if (row) row.sentAt = sentAtMs
    },
    async cancelPending(handle) {
      let deleted = 0
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!
        if (r.handle === handle && r.sentAt === null) {
          rows.splice(i, 1)
          deleted += 1
        }
      }
      return deleted
    },
    _rows() {
      return rows.map((r) => ({ ...r }))
    },
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface OutgoingScheduler {
  /**
   * Persist the tail of a reply burst for later delivery.
   *
   * `bubbles` is the FULL reply (including bubble 0). Bubble 0 is sent inline by
   * the caller and is NEVER persisted. For i in 1..N-1 we persist a row with
   * seq = i and sendAt = nowMs + sum(gaps[1..i]) (cumulative). With <= 1 bubble
   * nothing is persisted. Pacing gaps come from pacedDelays (already clamped).
   */
  schedule(
    handle: string,
    bubbles: string[],
    opts?: { nowMs?: number; simOpts?: TypingSimOpts },
  ): Promise<void>
  /**
   * Deliver every row due at nowMs, in send_at order. For each row: call send();
   * on success markSent(id, nowMs). A send that throws is caught, logged, and the
   * row is LEFT pending (no markSent) so the next tick retries it — the failure
   * never aborts the drain or the rows after it. Returns the count successfully
   * sent.
   */
  drainDue(
    nowMs: number,
    send: (handle: string, content: string) => Promise<void>,
  ): Promise<number>
  /** Delete still-pending rows for a handle; return the count deleted. */
  cancelPending(handle: string): Promise<number>
}

export function createOutgoingScheduler(db: OutgoingSchedulerDB): OutgoingScheduler {
  return {
    async schedule(handle, bubbles, opts) {
      // Nothing to defer: a single bubble (or empty) is fully handled inline.
      if (bubbles.length <= 1) return

      const nowMs = opts?.nowMs ?? Date.now()
      // Per-bubble gaps; index 0 = 0, index i = gap BEFORE bubbles[i]. Already
      // clamped to MAX_TOTAL_MS by pacedDelays — do not recompute.
      const gaps = pacedDelays(bubbles, opts?.simOpts)

      const toInsert: Array<{ handle: string; content: string; seq: number; sendAt: number }> = []
      let cumulative = 0
      for (let i = 1; i < bubbles.length; i++) {
        cumulative += gaps[i]! // sum of gaps[1..i]
        toInsert.push({
          handle,
          content: bubbles[i]!,
          seq: i,
          sendAt: nowMs + cumulative,
        })
      }
      await db.insertBubbles(toInsert)
    },

    async drainDue(nowMs, send) {
      const due = await db.selectDue(nowMs)
      let sentCount = 0
      for (const row of due) {
        try {
          await send(row.handle, row.content)
        } catch (err) {
          // Per-row isolation: leave this row pending (no markSent) so it retries
          // next tick, log, and move on to the next due row.
          console.error(
            `[outgoing-scheduler] send failed for bubble ${row.id} (${row.handle}, seq ${row.seq}); leaving pending`,
            err,
          )
          continue
        }
        await db.markSent(row.id, nowMs)
        sentCount += 1
      }
      return sentCount
    },

    async cancelPending(handle) {
      return db.cancelPending(handle)
    },
  }
}

// ---------------------------------------------------------------------------
// Drainer loop (thin setInterval wrapper — kept tiny on purpose)
// ---------------------------------------------------------------------------

/**
 * Drive scheduler.drainDue on a fixed interval. Errors are swallowed/logged so a
 * single bad tick never kills the interval. `clock` defaults to Date.now (it is
 * overridable only so a test can prove the wiring without real wall-clock time).
 * The real logic lives in drainDue, not here — keep this dumb.
 *
 * RE-ENTRANCY GUARD (critical): a tick is SKIPPED while a previous tick is still
 * draining. drainDue selects rows by `sentAt IS null`, which stays true during the
 * send → markSent gap; a single send (sendProactive opens a fresh iMessage space)
 * can outlast intervalMs, so without this guard a second overlapping tick would
 * re-select and RE-SEND already-delivered bubbles (duplicate messages to a real
 * user). With exactly one drainer + this guard, no row is ever in flight twice.
 */
export function startDrainer(
  scheduler: Pick<OutgoingScheduler, 'drainDue'>,
  send: (handle: string, content: string) => Promise<void>,
  opts?: { intervalMs?: number; clock?: () => number },
): { stop(): void } {
  const intervalMs = opts?.intervalMs ?? 1000
  const clock = opts?.clock ?? Date.now
  let running = false

  const handle = setInterval(() => {
    if (running) return // previous tick still draining — skip, never overlap
    running = true
    void scheduler
      .drainDue(clock(), send)
      .catch((err) => {
        console.error('[outgoing-scheduler] drain tick failed', err)
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  // Don't let the drainer keep the process alive on its own.
  if (typeof handle.unref === 'function') handle.unref()

  return {
    stop() {
      clearInterval(handle)
    },
  }
}
