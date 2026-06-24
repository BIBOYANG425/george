import { describe, it, expect } from 'vitest'
import { checkRateLimit } from '../../src/adapters/rate-limiter.js'

// counters is a module-global Map, so each assertion uses a UNIQUE key to avoid
// cross-test bleed (no reset is exported, matching the squad-draft usage).
describe('checkRateLimit — parameterized {max, windowMs}', () => {
  it('defaults to 10/60s (squad-draft byte-for-byte): 10 allowed, 11th blocked', () => {
    const k = `default-${Date.now()}-${Math.random()}`
    for (let i = 0; i < 10; i++) expect(checkRateLimit(k).allowed).toBe(true)
    const r = checkRateLimit(k)
    expect(r.allowed).toBe(false)
    expect(r.retryAfterMs).toBeGreaterThan(0)
  })

  it('honors a custom max (burst-guard uses perMin*strikes over strikes*60s)', () => {
    const k = `max-${Date.now()}-${Math.random()}`
    for (let i = 0; i < 3; i++) expect(checkRateLimit(k, { max: 3, windowMs: 180_000 }).allowed).toBe(true)
    expect(checkRateLimit(k, { max: 3, windowMs: 180_000 }).allowed).toBe(false)
  })

  it('distinct keys never collide (squad-draft key vs spectrum sender key)', () => {
    const a = `squad-${Date.now()}-${Math.random()}`
    const b = `spectrum-${Date.now()}-${Math.random()}`
    checkRateLimit(a, { max: 1 })
    expect(checkRateLimit(a, { max: 1 }).allowed).toBe(false) // a is now over its limit
    expect(checkRateLimit(b, { max: 1 }).allowed).toBe(true) // b is independent
  })
})
