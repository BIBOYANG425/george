import { log } from '../observability/logger.js'

const WINDOW_MS = 60_000
const MAX_MESSAGES = 10

const counters = new Map<string, { count: number; windowStart: number; windowMs: number }>()

// Fixed-window per-key counter. Defaults (10 / 60s) preserve the squad-draft
// caller byte-for-byte. The Spectrum burst guard passes its own {max, windowMs}
// (e.g. 90 / 180s = "sustained >30/min for 3 min") so there is ONE rate-limit
// implementation, not two. Keyed by an arbitrary string, so distinct callers
// (req.ip+':squad_draft' vs a Spectrum senderId) never collide.
export function checkRateLimit(
  key: string,
  opts: { max?: number; windowMs?: number } = {},
): { allowed: boolean; retryAfterMs?: number } {
  const max = opts.max ?? MAX_MESSAGES
  const windowMs = opts.windowMs ?? WINDOW_MS
  const now = Date.now()
  const entry = counters.get(key)

  if (!entry || now - entry.windowStart > windowMs) {
    counters.set(key, { count: 1, windowStart: now, windowMs })
    return { allowed: true }
  }

  if (entry.count >= max) {
    const retryAfterMs = windowMs - (now - entry.windowStart)
    log('warn', 'rate_limit_hit', { key, count: entry.count, max })
    return { allowed: false, retryAfterMs }
  }

  entry.count++
  return { allowed: true }
}

setInterval(() => {
  // Evict per-entry: an entry is stale only once 2x ITS OWN window has elapsed.
  // A fixed WINDOW_MS*2 cutoff would delete a longer custom window (e.g. the
  // Spectrum burst guard's 180s) mid-flight, resetting its counter and letting a
  // paced flood evade the cap. Squad-draft (60s) keeps the same 120s cutoff.
  const now = Date.now()
  for (const [key, entry] of counters) {
    if (now - entry.windowStart > entry.windowMs * 2) counters.delete(key)
  }
}, WINDOW_MS * 5)

export const RATE_LIMIT_RESPONSE = '你发太快了 —— 缓一分钟再来。'
