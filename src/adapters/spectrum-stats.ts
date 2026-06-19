// src/adapters/spectrum-stats.ts
// In-memory health telemetry for the Spectrum inbound stream. The adapter
// updates these counters as it connects, receives messages, errors, and
// reconnects; /health reads them so the iMessage ear's liveness is observable
// WITHOUT tailing deploy logs.
//
// Why this exists: today's Photon failure modes (CatchUpEvents UNAVAILABLE, 502,
// endpoint ETIMEDOUT) all silently wedge the stream. spectrum-ts retries
// internally and never throws to our reconnect loop, so George goes deaf with no
// thrown error and no george-level log. The visible tell is a growing
// "secondsSinceInbound" while state stays 'connected'. Exposing that turns a
// silent outage into something a monitor (or the admin dashboard) can alert on.
//
// No imports on purpose: importing this module never pulls in spectrum-ts (native
// deps), so index.ts can read it in /health on every platform (incl. the legacy
// path that must not load spectrum-ts).
//
// Header last reviewed: 2026-06-19

type SpectrumStreamState = 'idle' | 'connected' | 'reconnecting' | 'error'

interface SpectrumStatsInternal {
  state: SpectrumStreamState
  connectedAt: number | null // epoch ms of the most recent successful connect
  lastInboundAt: number | null // epoch ms of the most recent inbound message
  inboundCount: number
  reconnects: number
  lastError: string | null
}

const stats: SpectrumStatsInternal = {
  state: 'idle',
  connectedAt: null,
  lastInboundAt: null,
  inboundCount: 0,
  reconnects: 0,
  lastError: null,
}

export function recordSpectrumConnect(): void {
  stats.state = 'connected'
  stats.connectedAt = Date.now()
  stats.lastError = null
}

export function recordSpectrumInbound(): void {
  stats.lastInboundAt = Date.now()
  stats.inboundCount += 1
}

export function recordSpectrumError(message: string): void {
  stats.state = 'error'
  stats.lastError = message
}

export function recordSpectrumReconnecting(): void {
  stats.state = 'reconnecting'
  stats.reconnects += 1
}

export interface SpectrumHealth {
  state: SpectrumStreamState
  connectedAt: string | null
  lastInboundAt: string | null
  secondsSinceInbound: number | null
  inboundCount: number
  reconnects: number
  lastError: string | null
}

// Snapshot for /health. Timestamps are ISO; secondsSinceInbound is the key
// liveness signal — a large value while state is 'connected' means a silently
// wedged stream, which is exactly the failure no error surfaces today.
export function getSpectrumHealth(): SpectrumHealth {
  const now = Date.now()
  return {
    state: stats.state,
    connectedAt: stats.connectedAt ? new Date(stats.connectedAt).toISOString() : null,
    lastInboundAt: stats.lastInboundAt ? new Date(stats.lastInboundAt).toISOString() : null,
    secondsSinceInbound:
      stats.lastInboundAt === null ? null : Math.round((now - stats.lastInboundAt) / 1000),
    inboundCount: stats.inboundCount,
    reconnects: stats.reconnects,
    lastError: stats.lastError,
  }
}

// Test-only reset of module state.
export function __resetSpectrumStats(): void {
  stats.state = 'idle'
  stats.connectedAt = null
  stats.lastInboundAt = null
  stats.inboundCount = 0
  stats.reconnects = 0
  stats.lastError = null
}
