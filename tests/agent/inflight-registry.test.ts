// tests/agent/inflight-registry.test.ts
// Covers the shutdown-drain registry helper (src/agent/inflight-registry.ts):
//  - starts > 0 → drain resolves once the count decrements back to 0
//  - the bounded timeout path resolves too (a wedged turn never blocks exit)
import { describe, it, expect } from 'vitest'
import { createInflightRegistry } from '../../src/agent/inflight-registry.js'

describe('inflight registry (shutdown drain)', () => {
  it('resolves drain immediately when nothing is in flight', async () => {
    const reg = createInflightRegistry()
    const res = await reg.drain(1000)
    expect(res).toEqual({ drained: true, remaining: 0 })
  })

  it('drain resolves when the in-flight count hits 0', async () => {
    const reg = createInflightRegistry()
    reg.begin()
    reg.begin()
    expect(reg.count()).toBe(2)

    const drained = reg.drain(1000)
    // Still pending — two turns outstanding.
    reg.end()
    expect(reg.count()).toBe(1)
    reg.end()
    expect(reg.count()).toBe(0)

    const res = await drained
    expect(res).toEqual({ drained: true, remaining: 0 })
  })

  it('drain resolves via the bounded timeout when a turn never finishes', async () => {
    const reg = createInflightRegistry()
    reg.begin()
    const res = await reg.drain(15)
    expect(res.drained).toBe(false)
    expect(res.remaining).toBe(1)
  })

  it('end() never drives the count below 0', () => {
    const reg = createInflightRegistry()
    reg.end()
    reg.end()
    expect(reg.count()).toBe(0)
    reg.begin()
    expect(reg.count()).toBe(1)
  })
})
