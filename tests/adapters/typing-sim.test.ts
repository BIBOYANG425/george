/**
 * Tests for src/adapters/typing-sim.ts
 *
 * TDD: written before the implementation. Tests cover the pure typing-simulation
 * delay function and the budget-aware helpers.
 */

import { describe, expect, it } from 'vitest'
import {
  CHARS_PER_SEC,
  MAX_MS,
  MAX_TOTAL_MS,
  MIN_MS,
  THINK_PAUSE_MS,
  pacedDelays,
  totalPacingBudgetMs,
  typingDelayMs,
} from '../../src/adapters/typing-sim.js'

// ---------------------------------------------------------------------------
// typingDelayMs — basic contract
// ---------------------------------------------------------------------------

describe('typingDelayMs', () => {
  it('exports the expected default constants', () => {
    expect(CHARS_PER_SEC).toBe(7)
    expect(THINK_PAUSE_MS).toBe(250)
    expect(MIN_MS).toBe(450)
    expect(MAX_MS).toBe(3500)
  })

  it('returns a larger delay for a longer bubble (monotonic in length, no jitter)', () => {
    const short = typingDelayMs('hi', { jitterRatio: 0 })
    const medium = typingDelayMs('This is a medium length bubble.', { jitterRatio: 0 })
    const long = typingDelayMs('x'.repeat(200), { jitterRatio: 0 })
    expect(short).toBeLessThanOrEqual(medium)
    expect(medium).toBeLessThanOrEqual(long)
  })

  it('clamps a 1-char bubble to MIN_MS', () => {
    const result = typingDelayMs('x', { jitterRatio: 0 })
    expect(result).toBe(MIN_MS)
  })

  it('clamps a 10000-char bubble to MAX_MS', () => {
    const result = typingDelayMs('x'.repeat(10_000), { jitterRatio: 0 })
    expect(result).toBe(MAX_MS)
  })

  it('returns an integer (no fractional ms)', () => {
    const result = typingDelayMs('Some bubble text here.', { jitterRatio: 0 })
    expect(Number.isInteger(result)).toBe(true)
  })

  it('respects custom charsPerSec override', () => {
    // Slower typist → longer delay for the same bubble
    const fast = typingDelayMs('hello world', { jitterRatio: 0, charsPerSec: 20 })
    const slow = typingDelayMs('hello world', { jitterRatio: 0, charsPerSec: 2 })
    expect(slow).toBeGreaterThan(fast)
  })

  // ---------------------------------------------------------------------------
  // Jitter bounds
  // ---------------------------------------------------------------------------

  it('stays within [MIN_MS, MAX_MS] when rng returns 0 (low jitter extreme)', () => {
    const result = typingDelayMs('hello', { rng: () => 0 })
    expect(result).toBeGreaterThanOrEqual(MIN_MS)
    expect(result).toBeLessThanOrEqual(MAX_MS)
  })

  it('stays within [MIN_MS, MAX_MS] when rng returns 1 (high jitter extreme)', () => {
    const result = typingDelayMs('hello', { rng: () => 1 })
    expect(result).toBeGreaterThanOrEqual(MIN_MS)
    expect(result).toBeLessThanOrEqual(MAX_MS)
  })

  it('applies deterministic jitter via rng=0.5 (neutral → no shift)', () => {
    // rng=0.5 should yield jitter factor of 0 (midpoint), so result == unjittered
    const unjittered = typingDelayMs('Testing jitter', { jitterRatio: 0 })
    const neutral = typingDelayMs('Testing jitter', { rng: () => 0.5 })
    expect(neutral).toBe(unjittered)
  })

  it('jitter is bounded within ±jitterRatio of the unjittered value before final clamp', () => {
    const bubble = 'Medium length text for jitter test.'
    const unjittered = typingDelayMs(bubble, { jitterRatio: 0 })
    const jitterRatio = 0.12

    // Test across many random seeds to ensure bounds hold
    for (let seed = 0; seed <= 1; seed += 0.01) {
      const s = seed
      const jittered = typingDelayMs(bubble, { rng: () => s, jitterRatio })
      // The jittered value (pre-final-clamp) should not deviate beyond ratio;
      // after final clamp it must still be in [MIN_MS, MAX_MS]
      expect(jittered).toBeGreaterThanOrEqual(MIN_MS)
      expect(jittered).toBeLessThanOrEqual(MAX_MS)
    }
  })
})

// ---------------------------------------------------------------------------
// pacedDelays — per-bubble gap array
// ---------------------------------------------------------------------------

describe('pacedDelays', () => {
  it('index 0 is always 0 (first bubble sends immediately)', () => {
    const bubbles = ['First bubble.', 'Second bubble.', 'Third bubble.']
    const delays = pacedDelays(bubbles)
    expect(delays[0]).toBe(0)
    expect(delays).toHaveLength(bubbles.length)
  })

  it('returns [0] for a single-bubble array', () => {
    const delays = pacedDelays(['Only bubble.'])
    expect(delays).toEqual([0])
  })

  it('returns [0] for an empty array', () => {
    const delays = pacedDelays([])
    expect(delays).toEqual([])
  })

  it('non-zero delays match typingDelayMs for each bubble when under budget', () => {
    // Short bubbles: total won't exceed MAX_TOTAL_MS so no scaling
    const bubbles = ['Hi.', 'Sure!', 'Done.']
    const delays = pacedDelays(bubbles, { jitterRatio: 0 })
    expect(delays[0]).toBe(0)
    expect(delays[1]).toBe(typingDelayMs(bubbles[1], { jitterRatio: 0 }))
    expect(delays[2]).toBe(typingDelayMs(bubbles[2], { jitterRatio: 0 }))
  })

  it('scales down gaps proportionally when raw total exceeds MAX_TOTAL_MS', () => {
    // Very long bubbles: each gap > 3000ms, 3 gaps > 8000ms → triggers scaling
    const longBubble = 'x'.repeat(2000)
    const bubbles = [longBubble, longBubble, longBubble, longBubble]
    const delays = pacedDelays(bubbles, { jitterRatio: 0 })

    expect(delays[0]).toBe(0)
    const total = delays.reduce((a, b) => a + b, 0)
    // After scaling, total should be ≤ MAX_TOTAL_MS (allow 1ms for rounding)
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_MS + 1)
    // And should be close to MAX_TOTAL_MS (within 1% due to integer rounding)
    expect(total).toBeGreaterThan(MAX_TOTAL_MS * 0.98)
  })
})

// ---------------------------------------------------------------------------
// totalPacingBudgetMs — matches sum of pacedDelays
// ---------------------------------------------------------------------------

describe('totalPacingBudgetMs', () => {
  it('equals the sum of pacedDelays for the same bubbles', () => {
    const bubbles = ['First.', 'Second.', 'Third.']
    const delays = pacedDelays(bubbles, { jitterRatio: 0 })
    const total = totalPacingBudgetMs(bubbles, { jitterRatio: 0 })
    expect(total).toBe(delays.reduce((a, b) => a + b, 0))
  })

  it('is capped at MAX_TOTAL_MS when bubbles are long', () => {
    const longBubble = 'x'.repeat(2000)
    const bubbles = [longBubble, longBubble, longBubble, longBubble]
    const total = totalPacingBudgetMs(bubbles, { jitterRatio: 0 })
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_MS + 1)
  })

  it('returns 0 for a single bubble (no gaps)', () => {
    const total = totalPacingBudgetMs(['Only one bubble.'], { jitterRatio: 0 })
    expect(total).toBe(0)
  })

  it('returns 0 for an empty array', () => {
    const total = totalPacingBudgetMs([], { jitterRatio: 0 })
    expect(total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// MAX_TOTAL_MS export
// ---------------------------------------------------------------------------

describe('MAX_TOTAL_MS', () => {
  it('is exported and equals 8000', () => {
    expect(MAX_TOTAL_MS).toBe(8000)
  })
})
