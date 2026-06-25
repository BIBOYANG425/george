/**
 * Typing-simulation delay for multi-bubble replies.
 *
 * Background: George's split-response adapter fires N bubbles in sequence. The
 * original approach used a flat 600ms gap (INTER_MESSAGE_DELAY_MS) between
 * every bubble regardless of length — readable as a bot. Real people type the
 * next message while the previous one lands; longer messages take proportionally
 * longer to compose. This module provides a pure, length-aware gap function that
 * mimics that behaviour.
 *
 * Design:
 *  - typingDelayMs(bubble)  → the gap to wait BEFORE sending `bubble`.
 *  - pacedDelays(bubbles)   → per-bubble gap array (index 0 = 0: first bubble
 *                              sends immediately).
 *  - totalPacingBudgetMs    → sum of pacedDelays, capped at MAX_TOTAL_MS.
 *
 * All functions are pure (no Date.now, no side effects). The jitter source
 * defaults to Math.random but can be overridden via opts.rng so callers can
 * write deterministic tests.
 *
 * Header last reviewed: 2026-06-24
 */

// ---------------------------------------------------------------------------
// Tunable defaults — exported so tests and later callers can reference them
// without duplicating the magic numbers.
// ---------------------------------------------------------------------------

/** Characters per second assumed for a "normal" typing speed. */
export const CHARS_PER_SEC = 7

/** Base think/compose pause added on top of the character-time estimate (ms). */
export const THINK_PAUSE_MS = 250

/** Minimum inter-bubble gap: enough to let the previous bubble render (ms). */
export const MIN_MS = 450

/** Maximum inter-bubble gap: keeps conversation from stalling (ms). */
export const MAX_MS = 3500

/** Hard cap on the total accumulated gap for a full reply burst (ms). */
export const MAX_TOTAL_MS = 8000

/** Fractional jitter band applied to each gap (±12%). */
const DEFAULT_JITTER_RATIO = 0.12

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Overrides for typingDelayMs/pacedDelays/totalPacingBudgetMs. */
export interface TypingSimOpts {
  /** Override CHARS_PER_SEC. */
  charsPerSec?: number
  /** Override THINK_PAUSE_MS. */
  thinkPauseMs?: number
  /** Override MIN_MS. */
  minMs?: number
  /** Override MAX_MS. */
  maxMs?: number
  /**
   * Override jitter band (0 disables jitter entirely).
   * When set, it replaces DEFAULT_JITTER_RATIO (not the rng).
   */
  jitterRatio?: number
  /**
   * Replaceable RNG for deterministic tests. Must return a value in [0, 1).
   * Defaults to Math.random.
   */
  rng?: () => number
}

// ---------------------------------------------------------------------------
// Core delay function
// ---------------------------------------------------------------------------

/**
 * Compute the inter-bubble typing delay for a single bubble.
 *
 * Formula:
 *   base  = clamp(ceil(bubble.length / charsPerSec * 1000) + thinkPauseMs, minMs, maxMs)
 *   shift = base * jitterRatio * (rng() * 2 - 1)   // ± jitterRatio fraction
 *   result = clamp(round(base + shift), minMs, maxMs)
 *
 * Jitter is applied THEN the result is clamped again, so jitter can never push
 * the delay outside [minMs, maxMs].
 */
export function typingDelayMs(bubble: string, opts?: TypingSimOpts): number {
  const charsPerSec = opts?.charsPerSec ?? CHARS_PER_SEC
  const thinkPauseMs = opts?.thinkPauseMs ?? THINK_PAUSE_MS
  const minMs = opts?.minMs ?? MIN_MS
  const maxMs = opts?.maxMs ?? MAX_MS
  const jitterRatio = opts?.jitterRatio ?? DEFAULT_JITTER_RATIO
  const rng = opts?.rng ?? Math.random

  // Character-time estimate: how long this bubble would take a person to type.
  const charTimeMs = Math.ceil((bubble.length / charsPerSec) * 1000)

  // Base delay: clamp to [minMs, maxMs] before jitter.
  const base = clamp(charTimeMs + thinkPauseMs, minMs, maxMs)

  // Jitter: rng() in [0, 1) → shift in (-jitterRatio, +jitterRatio).
  // rng() = 0.5 → shift = 0 (neutral midpoint).
  const shift = base * jitterRatio * (rng() * 2 - 1)

  // Apply jitter then clamp again so jitter never escapes the band.
  return clamp(Math.round(base + shift), minMs, maxMs)
}

// ---------------------------------------------------------------------------
// Budget-aware helpers
// ---------------------------------------------------------------------------

/**
 * Per-bubble gap array for a full bubble burst.
 *
 * Returns an array of the same length as `bubbles`:
 *  - Index 0 is always 0 (first bubble sends immediately, no preceding gap).
 *  - Index i (i ≥ 1) is the gap to wait BEFORE sending bubbles[i].
 *
 * If the raw sum of gaps[1..] exceeds MAX_TOTAL_MS, all gaps are scaled down
 * proportionally so the total ≈ MAX_TOTAL_MS (integer rounding may cause the
 * actual sum to be ≤ MAX_TOTAL_MS by up to N-1 ms).
 *
 * Pure: no side effects, no Date.now. The rng is called once per bubble[i≥1].
 */
export function pacedDelays(bubbles: string[], opts?: TypingSimOpts): number[] {
  if (bubbles.length === 0) return []
  if (bubbles.length === 1) return [0]

  // Raw per-bubble gaps: index 0 = 0, index i = typingDelayMs(bubbles[i]).
  const raw: number[] = [0]
  for (let i = 1; i < bubbles.length; i++) {
    raw.push(typingDelayMs(bubbles[i]!, opts))
  }

  const rawTotal = raw.reduce((a, b) => a + b, 0) // index 0 contributes 0

  if (rawTotal <= MAX_TOTAL_MS) {
    return raw
  }

  // Scale down proportionally. Index 0 stays 0.
  const scale = MAX_TOTAL_MS / rawTotal
  const scaled: number[] = [0]
  for (let i = 1; i < raw.length; i++) {
    scaled.push(Math.round(raw[i]! * scale))
  }
  return scaled
}

/**
 * Total accumulated pacing budget for a reply burst.
 *
 * Equals the sum of pacedDelays(bubbles, opts). Capped at MAX_TOTAL_MS (integer
 * rounding may produce a value ≤ MAX_TOTAL_MS by a few ms).
 */
export function totalPacingBudgetMs(bubbles: string[], opts?: TypingSimOpts): number {
  return pacedDelays(bubbles, opts).reduce((a, b) => a + b, 0)
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/** Clamp `value` to the inclusive range [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}
