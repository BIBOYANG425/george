// src/adapters/spectrum-watchdog.ts
// Reliability watchdog for the Spectrum inbound stream. Self-heals the recurring
// "George goes silently DEAF" incident: Photon's stream wedges (CatchUpEvents
// UNAVAILABLE / "[upstream] Connection dropped"), spectrum-ts retries internally
// FOREVER and never throws to our reconnect loop, so /health still says
// connected while no inbound message can arrive. The only proven recovery so far
// has been a manual `railway redeploy` (a fresh process gets a working
// connection). This module makes that recovery automatic: detect the wedged
// stream from the in-process health snapshot and restart the process so Railway
// brings up a fresh container with a fresh Spectrum connection.
//
// WHY process.exit, not in-process reconnect: the thing that is wedged is
// spectrum-ts's OWN internal retry loop (it logs "[spectrum.stream] stream
// persistently failing; still retrying" via @photon-ai/otel — not subscribable
// from our process). Re-running createSpectrumClient() in-process does not clear
// that wedge reliably; a clean process restart does (it is exactly what the
// manual redeploy does). So on wedge we log + process.exit(1) and let Railway's
// auto-restart do the rest.
//
// DETECTION SIGNAL (honest, no false-alarm on a quiet night): we key on the
// reconnect-loop telemetry in spectrum-stats, NOT on inbound silence. A quiet
// beta night keeps state==='connected' with only a growing secondsSinceInbound,
// which spectrum-stats deliberately refuses to call "deaf" (see its header). We
// only restart when the stream has been in state 'error'/'reconnecting'
// CONTINUOUSLY for >= failSeconds with NO successful connect or inbound in that
// window — i.e. our own reconnect loop is cycling and not recovering. That
// fires on a genuine unrecoverable drop and stays silent on a quiet night.
//
// CRASH-LOOP GUARD (non-negotiable): a watchdog that can hard-loop process.exit
// is worse than the outage. We persist restart attempts to a small JSON marker
// file that survives the process restart (within the container's life). If we've
// already restarted maxRestarts times within windowSeconds, Photon is genuinely
// down for a long time and another restart won't help, so we STOP restarting:
// log spectrum_watchdog_backoff and stay up (degraded) so a human can intervene.
// A successful connect/inbound after a restart clears the history (recovery
// worked, the budget resets).
//
// Default-OFF: nothing here runs unless SPECTRUM_WATCHDOG_ENABLED is set. With it
// unset, startSpectrumWatchdog() is never called and behavior is byte-identical.
//
// FRESH-BOOT GUARD (isFreshNeverConnected): a process that has NEVER connected
// this boot cannot be helped by a restart — a fresh container hits the same
// failure AND its /tmp marker resets, which would bypass the crash-loop cap. So
// within the first minUptime window a never-connected wedge returns 'hold' (stay
// in-process, let the reconnect loop keep backing off) instead of exiting. The
// /tmp history logic still owns the connected-then-wedged case (connectedAt set).
//
// Pure core (shouldRestart / history math) takes an injected clock + exit + fs so
// tests assert decisions without real timers, a real process.exit, or real disk.
//
// Header last reviewed: 2026-07-07

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../observability/logger.js'
import { getSpectrumHealth, type SpectrumHealth } from './spectrum-stats.js'

// ── Tunables (env-driven, all with safe defaults) ──────────────────────
export interface WatchdogConfig {
  enabled: boolean
  // PRIMARY signal: continuous error/reconnecting seconds (no connect/inbound)
  // before "wedged". Fires when OUR reconnect loop is cycling and not recovering.
  failSeconds: number
  // SECONDARY signal: connected-but-SILENT seconds before "wedged". This catches
  // the actual recurring incident, where spectrum-ts's INTERNAL retry loop wedges
  // and never throws to us, so state stays 'connected' and the ONLY tell is a
  // growing secondsSinceInbound (see spectrum-stats header). Deliberately MUCH
  // larger than failSeconds and any plausible quiet beta night (~2h), so a quiet
  // 3am NEVER restarts — only a genuine multi-hour deaf-out does. 0 disables.
  silentSeconds: number
  // Max restarts allowed within windowSeconds before we back off (stay up).
  maxRestarts: number
  // Sliding window (seconds) the restart budget is counted over.
  windowSeconds: number
  // How often the watchdog timer evaluates health.
  intervalSeconds: number
  // Fresh-boot guard: within this many seconds of process start, a stream that has
  // NEVER connected this boot must NOT process.exit (see isFreshNeverConnected).
  minUptimeSeconds: number
  // Where the crash-loop marker is persisted (survives a process restart).
  markerPath: string
}

const DEFAULTS = {
  failSeconds: 300, // 5 min — our reconnect loop is visibly cycling
  silentSeconds: 10800, // 3h — connected but deaf; > a quiet night, < the 8.5h outage
  maxRestarts: 3,
  windowSeconds: 1800, // 30 min
  intervalSeconds: 60,
  minUptimeSeconds: 120, // 2 min — a never-connected fresh boot holds this long
  markerPath: path.join(os.tmpdir(), 'spectrum-watchdog-restarts.json'),
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Build config from env. enabled is strictly opt-in: only the literal 'true' (or
// '1') turns it on, so any unset/empty/typo value leaves the watchdog OFF.
export function loadWatchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const flag = env.SPECTRUM_WATCHDOG_ENABLED
  const enabled = flag === 'true' || flag === '1'
  return {
    enabled,
    failSeconds: intFromEnv(env, 'SPECTRUM_WATCHDOG_FAIL_SECONDS', DEFAULTS.failSeconds),
    // silentSeconds may be set to 0 to disable the connected-but-silent path
    // entirely (intFromEnv rejects non-positive, so we special-case 0 here).
    silentSeconds:
      env.SPECTRUM_WATCHDOG_SILENT_SECONDS === '0'
        ? 0
        : intFromEnv(env, 'SPECTRUM_WATCHDOG_SILENT_SECONDS', DEFAULTS.silentSeconds),
    maxRestarts: intFromEnv(env, 'SPECTRUM_WATCHDOG_MAX_RESTARTS', DEFAULTS.maxRestarts),
    windowSeconds: intFromEnv(env, 'SPECTRUM_WATCHDOG_WINDOW_SECONDS', DEFAULTS.windowSeconds),
    intervalSeconds: intFromEnv(env, 'SPECTRUM_WATCHDOG_INTERVAL_SECONDS', DEFAULTS.intervalSeconds),
    minUptimeSeconds: intFromEnv(env, 'SPECTRUM_WATCHDOG_MIN_UPTIME_SECONDS', DEFAULTS.minUptimeSeconds),
    markerPath: env.SPECTRUM_WATCHDOG_MARKER_PATH || DEFAULTS.markerPath,
  }
}

// ── Crash-loop marker (persisted restart history) ──────────────────────
// A list of epoch-ms timestamps, one per watchdog-triggered restart. Pruned to
// the sliding window on every read/write so it never grows unbounded.
export interface RestartHistory {
  restarts: number[]
}

const EMPTY_HISTORY: RestartHistory = { restarts: [] }

// Keep only restart timestamps within [now - windowSeconds, now].
export function pruneHistory(history: RestartHistory, nowMs: number, windowSeconds: number): RestartHistory {
  const cutoff = nowMs - windowSeconds * 1000
  return { restarts: history.restarts.filter((t) => t >= cutoff) }
}

// ── Pure decision core ─────────────────────────────────────────────────
//   'ok'      → healthy / not-yet-wedged.
//   'restart' → wedged, within budget: caller persists a marker + process.exit.
//   'backoff' → wedged but the restart budget is spent: log + stay up (degraded).
//   'hold'    → wedged, but a fresh boot that NEVER connected: exiting would just
//               crash-loop (and reset the /tmp budget), so stay in-process and let
//               the reconnect loop keep backing off. No exit, no marker.
export type WatchdogDecision = 'ok' | 'restart' | 'backoff' | 'hold'

export interface WedgeThresholds {
  failSeconds: number
  // 0 disables the connected-but-silent (in-library wedge) branch.
  silentSeconds: number
}

export interface ShouldRestartOpts {
  nowMs: number
  failSeconds: number
  silentSeconds: number
  maxRestarts: number
  windowSeconds: number
  history: RestartHistory
  // Fresh-boot guard inputs. Optional so existing callers/tests default to the
  // pre-guard behavior (no hold) — the guard only engages when BOTH are supplied.
  uptimeMs?: number
  minUptimeSeconds?: number
}

// A process that has NEVER connected this boot cannot be helped by a restart: a
// fresh container hits the same upstream failure AND its /tmp restart marker resets,
// which would bypass the crash-loop cap entirely. Within the first minUptime window
// we hold in-process (the reconnect loop keeps backing off) instead of exiting. Once
// the stream has connected AT LEAST once this boot (health.connectedAt set — it is
// retained across later errors), a restart is proven able to re-establish, so the
// connected-then-wedged path exits normally. Pure: caller injects uptime.
export function isFreshNeverConnected(
  health: SpectrumHealth,
  uptimeMs: number,
  minUptimeSeconds: number,
): boolean {
  const everConnectedThisBoot = Boolean(health.connectedAt)
  return !everConnectedThisBoot && uptimeMs < minUptimeSeconds * 1000
}

// Is the stream WEDGED right now? Two independent, honest signals — either one
// firing means wedged:
//
//  (A) Our reconnect loop is CYCLING: state is 'error'/'reconnecting'
//      continuously for >= failSeconds, with NO connect/inbound in that window.
//      Fires when the stream throws to our loop and reconnect can't recover.
//
//  (B) The stream is CONNECTED but DEAF (the real recurring incident):
//      spectrum-ts's internal retry loop wedges, never throws to us, so state
//      stays 'connected' and the ONLY tell is a growing secondsSinceInbound.
//      To NEVER false-alarm a quiet beta night (~2h of no texts at 3am is
//      HEALTHY, not deaf — see spectrum-stats header), this branch uses a
//      deliberately generous silentSeconds (default 3h, far above any quiet
//      night). silentSeconds=0 disables (B) entirely.
//
// Inbound silence at the SHORT failSeconds threshold is never, by itself,
// treated as wedged — only the long silentSeconds threshold, or an actual
// error/reconnecting state, escalates.
export function isWedged(health: SpectrumHealth, nowMs: number, t: WedgeThresholds): boolean {
  const lastConnect = health.connectedAt ? Date.parse(health.connectedAt) : -Infinity
  const lastInbound = health.lastInboundAt ? Date.parse(health.lastInboundAt) : -Infinity

  // ── Signal A: reconnect loop cycling without recovery ──
  if (health.state === 'error' || health.state === 'reconnecting') {
    const windowStart = nowMs - t.failSeconds * 1000
    // A connect or inbound inside the window means it recovered/recovering.
    if (lastConnect >= windowStart) return false
    if (lastInbound >= windowStart) return false
    // Must have been failing for at least failSeconds (anchor on last error);
    // a just-started failure gets time for the in-process reconnect to work.
    const lastErrorAt = health.lastErrorAt ? Date.parse(health.lastErrorAt) : -Infinity
    if (lastErrorAt > windowStart) return false
    return true
  }

  // ── Signal B: connected but deaf (in-library wedge) ──
  if (health.state === 'connected' && t.silentSeconds > 0) {
    // Never fire before we've actually connected and seen at least one inbound:
    // a brand-new connection with no traffic yet is not "deaf", and connecting
    // at all proves the line was alive. Require a known lastInbound, and that it
    // (and the connection) be older than silentSeconds.
    if (lastInbound === -Infinity) return false
    const silentStart = nowMs - t.silentSeconds * 1000
    if (lastInbound >= silentStart) return false
    // The connection itself must also predate the silent window — a very recent
    // (re)connect with no inbound yet is a fresh line, not a wedge.
    if (lastConnect === -Infinity || lastConnect >= silentStart) return false
    return true
  }

  return false
}

// Decide the watchdog action given the current health + persisted restart
// history. Pure: no clock, no fs, no process — caller injects nowMs + history.
//   'ok'      → stream healthy or not-yet-wedged; do nothing.
//   'restart' → wedged and within the restart budget; caller persists +exits.
//   'backoff' → wedged but the restart budget is spent; caller logs + stays up.
export function shouldRestart(health: SpectrumHealth, opts: ShouldRestartOpts): WatchdogDecision {
  if (!isWedged(health, opts.nowMs, { failSeconds: opts.failSeconds, silentSeconds: opts.silentSeconds })) {
    return 'ok'
  }
  // Fresh-container crash-loop guard (only when uptime inputs are supplied): a
  // never-connected fresh boot must not exit — hold in-process instead.
  if (
    opts.uptimeMs !== undefined &&
    opts.minUptimeSeconds !== undefined &&
    isFreshNeverConnected(health, opts.uptimeMs, opts.minUptimeSeconds)
  ) {
    return 'hold'
  }
  const pruned = pruneHistory(opts.history, opts.nowMs, opts.windowSeconds)
  if (pruned.restarts.length >= opts.maxRestarts) return 'backoff'
  return 'restart'
}

// ── Side-effecting shell (injectable for tests) ────────────────────────
export interface WatchdogDeps {
  now: () => number
  // Milliseconds since this process booted (process.uptime()*1000 in prod).
  // Injected so the fresh-boot guard is testable without real timers.
  uptimeMs: () => number
  readHealth: () => SpectrumHealth
  readHistory: () => RestartHistory
  writeHistory: (h: RestartHistory) => void
  clearHistory: () => void
  exit: (code: number) => void
  logFn: typeof log
}

// Default fs-backed history read/write. A corrupt/missing marker reads as empty
// (fail-open: a watchdog whose marker is unreadable must not crash-loop nor
// block — it simply starts with a clean budget).
export function readHistoryFromFile(markerPath: string): RestartHistory {
  try {
    const raw = fs.readFileSync(markerPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RestartHistory>
    if (Array.isArray(parsed?.restarts)) {
      return { restarts: parsed.restarts.filter((t) => typeof t === 'number') }
    }
  } catch {
    // missing or corrupt → empty
  }
  return { restarts: [...EMPTY_HISTORY.restarts] }
}

export function writeHistoryToFile(markerPath: string, history: RestartHistory): void {
  try {
    fs.writeFileSync(markerPath, JSON.stringify(history), 'utf8')
  } catch (err) {
    log('warn', 'spectrum_watchdog_marker_write_failed', { error: (err as Error).message, markerPath })
  }
}

export function clearHistoryFile(markerPath: string): void {
  try {
    fs.rmSync(markerPath, { force: true })
  } catch {
    // best-effort
  }
}

// One watchdog evaluation tick. Pure-ish: all I/O goes through deps, so tests
// drive it with a fake clock/health/history and assert exit/backoff WITHOUT
// exiting the test process. Returns the decision for assertion convenience.
export function watchdogTick(cfg: WatchdogConfig, deps: WatchdogDeps): WatchdogDecision {
  const health = deps.readHealth()
  const nowMs = deps.now()
  const thresholds: WedgeThresholds = { failSeconds: cfg.failSeconds, silentSeconds: cfg.silentSeconds }

  // Recovery: a connected stream that is NOT wedged (recent inbound, or simply
  // not deaf long enough to trip signal B) means a prior restart worked, or we
  // never failed → clear the budget so a future, unrelated outage gets its full
  // restart allowance again. NB: a connected stream CAN still be wedged (deaf)
  // via signal B, so we only clear when isWedged is false.
  if (health.state === 'connected' && !isWedged(health, nowMs, thresholds)) {
    deps.clearHistory()
    return 'ok'
  }

  const history = deps.readHistory()
  const uptimeMs = deps.uptimeMs()
  const decision = shouldRestart(health, {
    nowMs,
    failSeconds: cfg.failSeconds,
    silentSeconds: cfg.silentSeconds,
    maxRestarts: cfg.maxRestarts,
    windowSeconds: cfg.windowSeconds,
    history,
    uptimeMs,
    minUptimeSeconds: cfg.minUptimeSeconds,
  })

  // Fresh-boot hold: wedged but never connected this boot and still inside the
  // minUptime window. A restart would only crash-loop a fresh container (and reset
  // the /tmp budget), so stay up and let the in-process reconnect loop keep trying.
  // No exit, no marker write.
  if (decision === 'hold') {
    deps.logFn('warn', 'spectrum_watchdog_fresh_boot_hold', {
      reason: 'stream never connected this boot and uptime < minUptime; holding in-process (a restart would crash-loop a fresh container)',
      state: health.state,
      lastError: health.lastError,
      uptimeMs,
      minUptimeSeconds: cfg.minUptimeSeconds,
    })
    return 'hold'
  }

  if (decision === 'restart') {
    const pruned = pruneHistory(history, nowMs, cfg.windowSeconds)
    const next: RestartHistory = { restarts: [...pruned.restarts, nowMs] }
    deps.writeHistory(next)
    // Which signal fired: A = our reconnect loop cycling (state error/
    // reconnecting); B = connected-but-deaf (in-library wedge, the recurring
    // incident). Helps triage which Photon failure mode hit.
    const signal = health.state === 'connected' ? 'B:connected-but-deaf' : 'A:reconnect-loop-cycling'
    deps.logFn('error', 'spectrum_watchdog_restart', {
      reason: 'stream wedged; restarting process so a fresh container gets a fresh Spectrum connection',
      signal,
      state: health.state,
      lastError: health.lastError,
      lastErrorAt: health.lastErrorAt,
      secondsSinceInbound: health.secondsSinceInbound,
      failSeconds: cfg.failSeconds,
      silentSeconds: cfg.silentSeconds,
      restartCountInWindow: next.restarts.length,
      maxRestarts: cfg.maxRestarts,
      windowSeconds: cfg.windowSeconds,
    })
    deps.exit(1)
    return 'restart'
  }

  if (decision === 'backoff') {
    const pruned = pruneHistory(history, nowMs, cfg.windowSeconds)
    deps.logFn('error', 'spectrum_watchdog_backoff', {
      reason: 'restart budget exhausted; Photon likely down — staying up (degraded) for human intervention',
      state: health.state,
      lastError: health.lastError,
      restartCountInWindow: pruned.restarts.length,
      maxRestarts: cfg.maxRestarts,
      windowSeconds: cfg.windowSeconds,
    })
    return 'backoff'
  }

  return 'ok'
}

// ── Timer lifecycle (started by the spectrum adapter when the flag is on) ──
let watchdogTimer: ReturnType<typeof setInterval> | null = null

// Start the periodic watchdog. No-op (returns false) when disabled, so the
// default-OFF path installs no timer at all. Idempotent: a second start with a
// timer already running is ignored. Returns true iff a timer was installed.
export function startSpectrumWatchdog(cfg: WatchdogConfig = loadWatchdogConfig()): boolean {
  if (!cfg.enabled) return false
  if (watchdogTimer) return false

  const deps: WatchdogDeps = {
    now: () => Date.now(),
    uptimeMs: () => process.uptime() * 1000,
    readHealth: getSpectrumHealth,
    readHistory: () => readHistoryFromFile(cfg.markerPath),
    writeHistory: (h) => writeHistoryToFile(cfg.markerPath, h),
    clearHistory: () => clearHistoryFile(cfg.markerPath),
    exit: (code) => process.exit(code),
    logFn: log,
  }

  log('info', 'spectrum_watchdog_started', {
    failSeconds: cfg.failSeconds,
    maxRestarts: cfg.maxRestarts,
    windowSeconds: cfg.windowSeconds,
    intervalSeconds: cfg.intervalSeconds,
  })

  watchdogTimer = setInterval(() => {
    try {
      watchdogTick(cfg, deps)
    } catch (err) {
      // A watchdog must never crash the process via its own bug — log and keep
      // ticking. (process.exit on a real wedge is intentional and lives inside
      // watchdogTick; that path is not caught as an error here.)
      log('warn', 'spectrum_watchdog_tick_failed', { error: (err as Error).message })
    }
  }, cfg.intervalSeconds * 1000)
  // Don't keep the event loop alive solely for the watchdog timer.
  watchdogTimer.unref?.()
  return true
}

// Stop + clear the watchdog timer (called from stopSpectrumAdapter).
export function stopSpectrumWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

// Test-only: is a watchdog timer currently installed?
export function __watchdogTimerActive(): boolean {
  return watchdogTimer !== null
}
