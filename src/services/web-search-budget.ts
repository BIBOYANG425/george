// src/services/web-search-budget.ts
// Per-student daily budget for the (pricier) WebSearch server tool. Places
// search is cheap and shares the geo budget; web search is rationed here.
// Mirrors geo-rate-limit.ts but splits the read-only check from the record:
// WebSearch is a server tool we cannot intercept per call, so we read the
// actual web_search_requests count off the turn's usage and record it after.
//
// Default: 15 searches / 24h / student (env WEB_SEARCH_DAILY_CAP). In-process
// memory, fixed 24h buckets keyed on studentId.
//
// Header last reviewed: 2026-06-13
import { log } from '../observability/logger.js'

const WINDOW_MS = 24 * 60 * 60 * 1000

function maxPerDay(): number {
  const n = Number(process.env.WEB_SEARCH_DAILY_CAP)
  return Number.isFinite(n) && n > 0 ? n : 15
}

interface Bucket { windowStart: number; count: number }
const buckets = new Map<string, Bucket>()

function bucketFor(studentId: string, now: number): Bucket {
  const b = buckets.get(studentId)
  if (!b || now - b.windowStart >= WINDOW_MS) {
    const fresh = { windowStart: now, count: 0 }
    buckets.set(studentId, fresh)
    return fresh
  }
  return b
}

// Read-only: true when the student has already hit today's cap.
export function isWebSearchOverCap(studentId: string, now: number = Date.now()): boolean {
  return bucketFor(studentId, now).count >= maxPerDay()
}

// Record actual web searches performed this turn (from usage.server_tool_use).
export function recordWebSearchUse(studentId: string, count: number, now: number = Date.now()): void {
  if (count <= 0) return
  const b = bucketFor(studentId, now)
  b.count += count
  if (b.count >= maxPerDay()) {
    log('warn', 'web_search_budget_exhausted', { studentId, count: b.count })
  }
}

// Test-only helper. Do not call from production code.
export function _resetWebSearchBudget(): void { buckets.clear() }
