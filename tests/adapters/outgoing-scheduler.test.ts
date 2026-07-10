/**
 * Tests for src/adapters/outgoing-scheduler.ts
 *
 * TDD: written before the implementation. Exercises the restart-durable
 * outgoing-bubble scheduler against the in-memory fake DB (no network).
 *
 * Key invariants under test:
 *  - bubble 0 is NEVER persisted (the caller sends it inline).
 *  - send_at timestamps are cumulative + strictly increasing and ≥ now.
 *  - drainDue only sends due rows, marks them sent, and is restart-durable
 *    (a fresh scheduler over the SAME db drains rows scheduled by another).
 *  - a per-row send failure is isolated: the row stays pending and re-sends.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createInMemoryOutgoingSchedulerDB,
  createOutgoingScheduler,
  startDrainer,
  startQueuePruner,
} from '../../src/adapters/outgoing-scheduler.js'

// Deterministic pacing: jitterRatio 0 removes randomness so send_at math is exact.
const SIM = { jitterRatio: 0 }

describe('createOutgoingScheduler.schedule', () => {
  it('persists bubbles[1..] only (bubble 0 sent inline), seq 1..N-1', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', ['a', 'b', 'c'], { nowMs: 1000, simOpts: SIM })

    const rows = db._rows()
    expect(rows).toHaveLength(2)
    // bubble 'a' (index 0) never persisted
    expect(rows.map((r) => r.content)).toEqual(['b', 'c'])
    expect(rows.map((r) => r.seq)).toEqual([1, 2])
    expect(rows.every((r) => r.handle === '+1555')).toBe(true)
    expect(rows.every((r) => r.sentAt === null)).toBe(true)
  })

  it('send_at is cumulative, strictly increasing and ≥ now', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    const now = 1000
    await sched.schedule('+1555', ['a', 'bb', 'ccc'], { nowMs: now, simOpts: SIM })

    const rows = db._rows().sort((x, y) => x.seq - y.seq)
    expect(rows[0]!.sendAt).toBeGreaterThan(now) // gap[1] > 0
    expect(rows[1]!.sendAt).toBeGreaterThan(rows[0]!.sendAt) // strictly increasing
  })

  it('persists nothing for a single-bubble reply', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', ['only'], { nowMs: 1000, simOpts: SIM })
    expect(db._rows()).toHaveLength(0)
  })

  it('persists nothing for an empty reply', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', [], { nowMs: 1000, simOpts: SIM })
    expect(db._rows()).toHaveLength(0)
  })
})

describe('createOutgoingScheduler.drainDue', () => {
  it('sends only due rows in send_at order, marks them sent, returns the count', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', ['a', 'b', 'c'], { nowMs: 1000, simOpts: SIM })

    const rows = db._rows().sort((x, y) => x.seq - y.seq)
    const firstDue = rows[0]!.sendAt
    const secondDue = rows[1]!.sendAt

    const sent: Array<{ handle: string; content: string }> = []
    const send = async (handle: string, content: string) => {
      sent.push({ handle, content })
    }

    // now between the two send_at values → only the first row is due.
    const n1 = await sched.drainDue(firstDue, send)
    expect(n1).toBe(1)
    expect(sent).toEqual([{ handle: '+1555', content: 'b' }])
    // first row marked sent, second still pending
    const after1 = db._rows().sort((x, y) => x.seq - y.seq)
    expect(after1[0]!.sentAt).toBe(firstDue)
    expect(after1[1]!.sentAt).toBeNull()

    // advance to second row's send_at → it drains now.
    const n2 = await sched.drainDue(secondDue, send)
    expect(n2).toBe(1)
    expect(sent).toEqual([
      { handle: '+1555', content: 'b' },
      { handle: '+1555', content: 'c' },
    ])
  })

  it('does not re-send already-sent rows', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', ['a', 'b'], { nowMs: 1000, simOpts: SIM })

    const future = 1_000_000
    const sent: string[] = []
    const send = async (_h: string, c: string) => {
      sent.push(c)
    }
    expect(await sched.drainDue(future, send)).toBe(1)
    // a second drain finds nothing pending
    expect(await sched.drainDue(future, send)).toBe(0)
    expect(sent).toEqual(['b'])
  })
})

describe('createOutgoingScheduler.cancelPending', () => {
  it('removes only the given handle pending rows; other handles + sent rows untouched', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    // +1555 gets two bursts; the first is drained (→ sent rows we must preserve),
    // the second stays pending (→ what cancelPending must delete).
    await sched.schedule('+1555', ['a', 'b', 'c'], { nowMs: 1000, simOpts: SIM })

    // Drain ONLY +1555's first-burst rows by sending to a future point, but keep
    // +1777 out of the store until after, so its rows never get marked sent.
    const future = 1_000_000
    await sched.drainDue(future, async () => {})
    const sentRowsBefore = db._rows().filter((r) => r.sentAt !== null).length
    expect(sentRowsBefore).toBe(2) // both first-burst +1555 rows are now sent

    // Now add pending rows: a fresh +1555 burst (to be cancelled) and a +1777
    // burst (an unrelated handle that must be left untouched).
    await sched.schedule('+1555', ['a', 'b'], { nowMs: 2000, simOpts: SIM })
    await sched.schedule('+1777', ['x', 'y'], { nowMs: 2000, simOpts: SIM })

    const before = db._rows()
    const pending1555Before = before.filter(
      (r) => r.handle === '+1555' && r.sentAt === null,
    ).length
    expect(pending1555Before).toBeGreaterThan(0)

    const deleted = await sched.cancelPending('+1555')
    const after = db._rows()

    // +1555 pending rows gone
    expect(after.filter((r) => r.handle === '+1555' && r.sentAt === null)).toHaveLength(0)
    // +1777 pending rows untouched
    expect(after.filter((r) => r.handle === '+1777' && r.sentAt === null)).toHaveLength(1)
    // already-sent rows preserved (the first +1555 burst)
    expect(after.filter((r) => r.sentAt !== null)).toHaveLength(sentRowsBefore)
    // deleted count matches the pending +1555 rows that existed
    expect(deleted).toBe(pending1555Before)
  })

  it('returns 0 when the handle has no pending rows', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    expect(await sched.cancelPending('+nobody')).toBe(0)
  })
})

describe('restart durability (the headline)', () => {
  it('a NEW scheduler over the SAME db drains rows scheduled by another', async () => {
    const db = createInMemoryOutgoingSchedulerDB()

    // Scheduler A schedules the burst, then the "process restarts".
    const schedA = createOutgoingScheduler(db)
    await schedA.schedule('+1555', ['hi', 'there', 'friend'], { nowMs: 1000, simOpts: SIM })
    expect(db._rows()).toHaveLength(2)

    // Scheduler B is constructed fresh over the SAME db instance (restart sim).
    const schedB = createOutgoingScheduler(db)

    const sent: string[] = []
    const send = async (_h: string, c: string) => {
      sent.push(c)
    }
    // advance now past every send_at → B drains all pending rows.
    const drained = await schedB.drainDue(1_000_000, send)
    expect(drained).toBe(2)
    expect(sent).toEqual(['there', 'friend'])
    expect(db._rows().every((r) => r.sentAt !== null)).toBe(true)
  })
})

describe('durable claims', () => {
  it('allows only one of two workers to claim and send the same due row', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const producer = createOutgoingScheduler(db, { workerId: 'producer' })
    await producer.schedule('+1555', ['first', 'tail'], { nowMs: 1000, simOpts: SIM })

    const workerA = createOutgoingScheduler(db, { workerId: 'worker-a' })
    const workerB = createOutgoingScheduler(db, { workerId: 'worker-b' })
    const delivered: string[] = []
    await Promise.all([
      workerA.drainDue(1_000_000, async (_h, content) => { delivered.push(`a:${content}`) }),
      workerB.drainDue(1_000_000, async (_h, content) => { delivered.push(`b:${content}`) }),
    ])

    expect(delivered).toHaveLength(1)
  })

  it('retries acknowledgement and retains the lease when acknowledgement remains ambiguous', async () => {
    const inner = createInMemoryOutgoingSchedulerDB()
    let failMarks = 3
    const db = {
      ...inner,
      markSent: vi.fn(async (...args: Parameters<typeof inner.markSent>) => {
        if (failMarks-- > 0) throw new Error('database unavailable after send')
        return inner.markSent(...args)
      }),
    }
    const scheduler = createOutgoingScheduler(db, { workerId: 'worker-a', markAttempts: 3, leaseMs: 10_000 })
    await scheduler.schedule('+1555', ['first', 'tail'], { nowMs: 1000, simOpts: SIM })
    const send = vi.fn(async () => {})

    expect(await scheduler.drainDue(1_000_000, send)).toBe(0)
    expect(db.markSent).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenCalledTimes(1)
    await scheduler.drainDue(1_000_001, send)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('per-row failure isolation', () => {
  it('a throwing send leaves that row pending; a later drain re-sends it', async () => {
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', ['a', 'boom'], { nowMs: 1000, simOpts: SIM })

    let attempts = 0
    const flaky = async (_h: string, _c: string) => {
      attempts += 1
      if (attempts === 1) throw new Error('send failed')
    }

    // first drain: send throws → 0 sent, row stays pending, no crash.
    const n1 = await sched.drainDue(1_000_000, flaky)
    expect(n1).toBe(0)
    const afterFail = db._rows()
    expect(afterFail).toHaveLength(1)
    expect(afterFail[0]!.sentAt).toBeNull()

    // second drain: send succeeds → row is delivered + marked sent.
    const n2 = await sched.drainDue(1_000_000, flaky)
    expect(n2).toBe(1)
    expect(db._rows()[0]!.sentAt).not.toBeNull()
  })

  it('continues to the next row when an earlier row fails', async () => {
    // Two distinct handles so a failure on one does not block the other.
    const db = createInMemoryOutgoingSchedulerDB()
    const sched = createOutgoingScheduler(db)
    await sched.schedule('+1555', ['a', 'fail-me'], { nowMs: 1000, simOpts: SIM })
    await sched.schedule('+1777', ['a', 'send-me'], { nowMs: 1000, simOpts: SIM })

    const delivered: string[] = []
    const send = async (_h: string, c: string) => {
      if (c === 'fail-me') throw new Error('nope')
      delivered.push(c)
    }
    const n = await sched.drainDue(1_000_000, send)
    expect(n).toBe(1)
    expect(delivered).toContain('send-me')
    // the failed row is still pending
    expect(db._rows().filter((r) => r.content === 'fail-me' && r.sentAt === null)).toHaveLength(1)
  })
})

describe('startDrainer re-entrancy guard', () => {
  it('skips a tick while the previous drain is still running (no overlap → no double-send)', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      let resolveFirst: ((value: void | PromiseLike<void>) => void) | undefined
      // drainDue selects on sentAt===null, which stays true during the send→markSent
      // gap. If a slow tick overlapped the next, the same rows would be re-selected
      // and RE-SENT. This proves the guard prevents that: tick 1 blocks; tick 2 is
      // skipped, not run concurrently.
      const scheduler = {
        drainDue: vi.fn(async (): Promise<number> => {
          calls += 1
          if (calls === 1) await new Promise<void>((res) => { resolveFirst = res })
          return 0
        }),
      }
      const send = async (): Promise<void> => {}
      const drainer = startDrainer(scheduler, send, { intervalMs: 10, clock: () => 0 })

      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(1) // tick 1 entered drainDue and is now blocked

      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(1) // tick 2 fired but the guard skipped it (no re-entry)

      resolveFirst?.(undefined) // let tick 1 complete → running flips back to false
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toBe(2) // a fresh tick now runs

      drainer.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off after an idle drain instead of polling every second', async () => {
    vi.useFakeTimers()
    try {
      const scheduler = { drainDue: vi.fn(async () => 0) }
      const drainer = startDrainer(scheduler, async () => {}, {
        activeIntervalMs: 10,
        idleIntervalMs: 100,
        errorIntervalMs: 200,
        clock: () => 0,
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(scheduler.drainDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(99)
      expect(scheduler.drainDue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(scheduler.drainDue).toHaveBeenCalledTimes(2)
      drainer.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pruneSentBefore', () => {
  it('removes only SENT rows older than the cutoff; pending + recent-sent remain', async () => {
    // Seed a mix directly: a pending row, an old sent row, a recent sent row.
    const db = createInMemoryOutgoingSchedulerDB([
      { id: 'pending', handle: '+1555', content: 'p', seq: 1, sendAt: 5000, sentAt: null },
      { id: 'old-sent', handle: '+1555', content: 'o', seq: 2, sendAt: 1000, sentAt: 1000 },
      { id: 'recent-sent', handle: '+1555', content: 'r', seq: 3, sendAt: 9000, sentAt: 9000 },
    ])
    // Cutoff sits between the two sent rows: old-sent (1000) < cutoff, recent (9000) ≥ cutoff.
    const deleted = await db.pruneSentBefore(5000)
    expect(deleted).toBe(1)

    const remaining = db._rows()
    expect(remaining.map((r) => r.id).sort()).toEqual(['pending', 'recent-sent'])
    // The pending row (sentAt null) is never pruned, even though sendAt < cutoff.
    expect(remaining.find((r) => r.id === 'pending')!.sentAt).toBeNull()
    // The old SENT row is gone.
    expect(remaining.find((r) => r.id === 'old-sent')).toBeUndefined()
  })
})

describe('startQueuePruner', () => {
  it('prunes with clock()-olderThanMs each tick; stop() halts further ticks', async () => {
    vi.useFakeTimers()
    try {
      const db = { pruneSentBefore: vi.fn(async (): Promise<number> => 0) }
      const pruner = startQueuePruner(db, {
        intervalMs: 1000,
        olderThanMs: 100,
        clock: () => 5000,
      })

      await vi.advanceTimersByTimeAsync(1000)
      expect(db.pruneSentBefore).toHaveBeenCalledTimes(1)
      expect(db.pruneSentBefore).toHaveBeenLastCalledWith(4900) // clock() - olderThanMs

      await vi.advanceTimersByTimeAsync(1000)
      expect(db.pruneSentBefore).toHaveBeenCalledTimes(2)

      pruner.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(db.pruneSentBefore).toHaveBeenCalledTimes(2) // no further ticks
    } finally {
      vi.useRealTimers()
    }
  })
})
