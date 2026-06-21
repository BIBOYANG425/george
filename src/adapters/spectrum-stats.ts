// src/adapters/spectrum-stats.ts
// In-memory health telemetry for the Spectrum inbound stream. The adapter
// updates these counters as it connects, receives messages, errors, and
// reconnects; /health reads them so the iMessage ear's liveness is observable
// WITHOUT tailing deploy logs.
//
// Why this exists: today's Photon failure modes (CatchUpEvents UNAVAILABLE, 502,
// endpoint ETIMEDOUT) all silently wedge the stream. spectrum-ts retries
// internally and never throws to our reconnect loop, so George goes deaf with no
// thrown error and no george-level log.
//
// LIBRARY-LIVENESS LIMITATION (investigated against spectrum-ts 3.1.0, 2026-06-21):
// the SDK exposes NO consumer-facing liveness signal we can key honest detection
// on. The iMessage provider declares no custom events (PlatformDef _Events param
// is `undefined`), so the public SpectrumInstance surface is `messages` (an
// AsyncIterable of [Space, Message]) + stop/send/edit/responding/webhook — no
// onError/onDisconnect/onConnect callback, no connection-state property, no
// keepalive/heartbeat. Internally `resumableOrderedStream.run()` catches every
// RetryableStreamError ("Connection dropped" / CatchUpEvents UNAVAILABLE), logs
// via @photon-ai/otel (not subscribable from our process), backs off, and retries
// FOREVER; it only surfaces an error to the consumer iterator if the retry loop
// itself crashes, never on a transient wedge. The consumer stream yields message
// VALUES only — no non-message events ever reach our for-await loop. `telemetry:
// true` merely exports OTel spans to Photon's own endpoint; nothing comes back.
//
// Consequence for this module: the ONLY tell of a silent wedge is a growing
// `secondsSinceInbound` while state stays 'connected'. But inbound-message
// silence is ALSO what a legitimately quiet night looks like (e.g. ~2h of no
// texts at 3am LA in the beta) — that is HEALTHY, not deaf. So we DO NOT derive a
// top-level "degraded" status from inbound silence: doing so would false-alarm
// every quiet period (alarm fatigue, worse than the status quo). Instead we
// expose the honest raw signals (`secondsSinceInbound`, plus a documented
// `staleInboundSeconds` advisory threshold the DASHBOARD may choose to surface)
// and let a human-aware monitor decide. True silent-wedge detection that can tell
// deaf from quiet is BLOCKED on spectrum-ts shipping a keepalive/connection-event
// or error/disconnect hook; revisit this module when it does (then move to the
// stream-activity-based design in the fix/health-stream-liveness PR description).
//
// What DID change here (the safe, no-false-alarm improvements): `lastErrorAt`
// and a derived `connectedDurationSeconds` on the snapshot, plus the advisory
// `staleInboundSeconds` constant. Error/reconnect tracking is unchanged.
//
// No imports on purpose: importing this module never pulls in spectrum-ts (native
// deps), so index.ts can read it in /health on every platform (incl. the legacy
// path that must not load spectrum-ts).
//
// Header last reviewed: 2026-06-21

type SpectrumStreamState = 'idle' | 'connected' | 'reconnecting' | 'error'

interface SpectrumStatsInternal {
  state: SpectrumStreamState
  connectedAt: number | null // epoch ms of the most recent successful connect
  lastInboundAt: number | null // epoch ms of the most recent inbound message
  inboundCount: number
  reconnects: number
  lastError: string | null
  lastErrorAt: number | null // epoch ms of the most recent recorded error
}

const stats: SpectrumStatsInternal = {
  state: 'idle',
  connectedAt: null,
  lastInboundAt: null,
  inboundCount: 0,
  reconnects: 0,
  lastError: null,
  lastErrorAt: null,
}

// Advisory threshold (seconds) the DASHBOARD may choose to flag when
// `secondsSinceInbound` exceeds it. This is intentionally NOT used to set a
// top-level degraded status — inbound silence alone cannot distinguish a quiet
// beta night from a silently-deaf stream (see header), so the call belongs to a
// human-aware monitor, not this module. Generous on purpose to avoid noise.
export const STALE_INBOUND_SECONDS = 1800

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
  stats.lastErrorAt = Date.now()
}

export function recordSpectrumReconnecting(): void {
  stats.state = 'reconnecting'
  stats.reconnects += 1
}

export interface SpectrumHealth {
  state: SpectrumStreamState
  connectedAt: string | null
  // Seconds the current connection has been up (since the last successful
  // connect), or null if never connected. A small value right after a spate of
  // reconnects is itself a useful tell.
  connectedDurationSeconds: number | null
  lastInboundAt: string | null
  secondsSinceInbound: number | null
  inboundCount: number
  reconnects: number
  lastError: string | null
  lastErrorAt: string | null
  // Advisory threshold (seconds) the dashboard MAY alert on when
  // secondsSinceInbound exceeds it. Exposed so the alert policy lives in the
  // monitor, not here. NOT a degraded signal on its own — inbound silence ≠ deaf
  // (a quiet night looks identical). See the module header.
  staleInboundSeconds: number
}

// Snapshot for /health. Timestamps are ISO. The honest liveness picture is the
// combination of (a) a recent unrecovered error (lastError/lastErrorAt while
// state is 'error'/'reconnecting') and (b) secondsSinceInbound. A large
// secondsSinceInbound while state is 'connected' is consistent with EITHER a
// silently wedged stream OR a legitimately quiet period — this module cannot
// tell them apart (spectrum-ts gives us no keepalive), so it reports the raw
// numbers and the advisory threshold rather than asserting "degraded".
export function getSpectrumHealth(): SpectrumHealth {
  const now = Date.now()
  return {
    state: stats.state,
    connectedAt: stats.connectedAt ? new Date(stats.connectedAt).toISOString() : null,
    connectedDurationSeconds:
      stats.connectedAt === null ? null : Math.round((now - stats.connectedAt) / 1000),
    lastInboundAt: stats.lastInboundAt ? new Date(stats.lastInboundAt).toISOString() : null,
    secondsSinceInbound:
      stats.lastInboundAt === null ? null : Math.round((now - stats.lastInboundAt) / 1000),
    inboundCount: stats.inboundCount,
    reconnects: stats.reconnects,
    lastError: stats.lastError,
    lastErrorAt: stats.lastErrorAt ? new Date(stats.lastErrorAt).toISOString() : null,
    staleInboundSeconds: STALE_INBOUND_SECONDS,
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
  stats.lastErrorAt = null
}
