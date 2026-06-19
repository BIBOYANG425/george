import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordSpectrumConnect,
  recordSpectrumInbound,
  recordSpectrumError,
  recordSpectrumReconnecting,
  getSpectrumHealth,
  __resetSpectrumStats,
} from '../../src/adapters/spectrum-stats.js'

describe('spectrum-stats', () => {
  beforeEach(() => __resetSpectrumStats())

  it('starts idle with no activity', () => {
    const h = getSpectrumHealth()
    expect(h.state).toBe('idle')
    expect(h.connectedAt).toBeNull()
    expect(h.lastInboundAt).toBeNull()
    expect(h.secondsSinceInbound).toBeNull()
    expect(h.inboundCount).toBe(0)
    expect(h.reconnects).toBe(0)
  })

  it('records a successful connect', () => {
    recordSpectrumConnect()
    const h = getSpectrumHealth()
    expect(h.state).toBe('connected')
    expect(h.connectedAt).not.toBeNull()
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
})
