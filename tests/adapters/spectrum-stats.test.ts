import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  recordSpectrumConnect,
  recordSpectrumInbound,
  recordSpectrumError,
  recordSpectrumReconnecting,
  getSpectrumHealth,
  STALE_INBOUND_SECONDS,
  __resetSpectrumStats,
} from '../../src/adapters/spectrum-stats.js'

describe('spectrum-stats', () => {
  beforeEach(() => __resetSpectrumStats())

  it('starts idle with no activity', () => {
    const h = getSpectrumHealth()
    expect(h.state).toBe('idle')
    expect(h.connectedAt).toBeNull()
    expect(h.connectedDurationSeconds).toBeNull()
    expect(h.lastInboundAt).toBeNull()
    expect(h.secondsSinceInbound).toBeNull()
    expect(h.inboundCount).toBe(0)
    expect(h.reconnects).toBe(0)
    expect(h.lastError).toBeNull()
    expect(h.lastErrorAt).toBeNull()
  })

  it('records a successful connect', () => {
    recordSpectrumConnect()
    const h = getSpectrumHealth()
    expect(h.state).toBe('connected')
    expect(h.connectedAt).not.toBeNull()
    expect(h.connectedDurationSeconds).toBeGreaterThanOrEqual(0)
  })

  it('counts inbound messages and exposes secondsSinceInbound', () => {
    recordSpectrumConnect()
    recordSpectrumInbound()
    recordSpectrumInbound()
    const h = getSpectrumHealth()
    expect(h.inboundCount).toBe(2)
    expect(h.lastInboundAt).not.toBeNull()
    expect(h.secondsSinceInbound).toBeGreaterThanOrEqual(0)
    expect(h.secondsSinceInbound).toBeLessThan(5)
  })

  it('records errors and counts reconnect attempts', () => {
    recordSpectrumError('connect ETIMEDOUT')
    expect(getSpectrumHealth().state).toBe('error')
    expect(getSpectrumHealth().lastError).toBe('connect ETIMEDOUT')
    recordSpectrumReconnecting()
    recordSpectrumReconnecting()
    const h = getSpectrumHealth()
    expect(h.state).toBe('reconnecting')
    expect(h.reconnects).toBe(2)
  })

  it('clears lastError on a fresh connect', () => {
    recordSpectrumError('boom')
    recordSpectrumConnect()
    expect(getSpectrumHealth().lastError).toBeNull()
  })

  // ── New observability fields (Case 3: honest snapshot, no false-alarm flag) ──

  it('populates lastErrorAt when an error is recorded, leaves it null otherwise', () => {
    expect(getSpectrumHealth().lastErrorAt).toBeNull()
    recordSpectrumError('CatchUpEvents UNAVAILABLE')
    const h = getSpectrumHealth()
    expect(h.lastErrorAt).not.toBeNull()
    // ISO timestamp shape
    expect(() => new Date(h.lastErrorAt as string).toISOString()).not.toThrow()
  })

  it('exposes the advisory staleInboundSeconds threshold (not a degraded flag)', () => {
    const h = getSpectrumHealth()
    expect(h.staleInboundSeconds).toBe(STALE_INBOUND_SECONDS)
    expect(STALE_INBOUND_SECONDS).toBeGreaterThan(0)
    // The health snapshot intentionally carries NO top-level degraded/healthy
    // boolean: inbound silence cannot be told apart from a quiet night, so the
    // module never asserts deafness. (Guards against a regression re-adding one.)
    expect(h).not.toHaveProperty('degraded')
    expect(h).not.toHaveProperty('healthy')
  })

  describe('with a fake clock', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('grows connectedDurationSeconds as the connection stays up', () => {
      vi.setSystemTime(new Date('2026-06-21T03:00:00.000Z'))
      recordSpectrumConnect()
      vi.setSystemTime(new Date('2026-06-21T05:00:00.000Z')) // +2h
      const h = getSpectrumHealth()
      expect(h.connectedDurationSeconds).toBe(2 * 60 * 60)
    })

    // THE false-alarm guard. A legitimately quiet beta night (no inbound for
    // hours) is HEALTHY, not deaf. The snapshot reports the long silence as a
    // raw number but state stays 'connected' and there is no degraded signal —
    // exactly so a quiet 3am does not page anyone.
    it('quiet-but-connected stays connected with no degraded signal despite long inbound silence', () => {
      vi.setSystemTime(new Date('2026-06-21T01:00:00.000Z'))
      recordSpectrumConnect()
      recordSpectrumInbound()
      // Jump 2h with zero inbound — the real "quiet 3am beta" scenario.
      vi.setSystemTime(new Date('2026-06-21T03:00:00.000Z'))
      const h = getSpectrumHealth()
      expect(h.state).toBe('connected')
      expect(h.secondsSinceInbound).toBe(2 * 60 * 60)
      // Silence exceeds the advisory threshold, yet there is NO degraded/healthy
      // verdict — the module refuses to call quiet "deaf".
      expect(h.secondsSinceInbound as number).toBeGreaterThan(h.staleInboundSeconds)
      expect(h).not.toHaveProperty('degraded')
      expect(h.lastError).toBeNull()
    })

    // A recent unrecovered error / reconnect IS surfaced — this is the honest,
    // non-silence-based signal a monitor CAN key on (state + lastError(At)).
    it('surfaces a recent error with a timestamp while reconnecting', () => {
      vi.setSystemTime(new Date('2026-06-21T03:00:00.000Z'))
      recordSpectrumConnect()
      vi.setSystemTime(new Date('2026-06-21T03:05:00.000Z'))
      recordSpectrumError('[upstream] Connection dropped')
      recordSpectrumReconnecting()
      const h = getSpectrumHealth()
      expect(h.state).toBe('reconnecting')
      expect(h.lastError).toBe('[upstream] Connection dropped')
      expect(h.lastErrorAt).toBe('2026-06-21T03:05:00.000Z')
      expect(h.reconnects).toBe(1)
    })
  })
})
