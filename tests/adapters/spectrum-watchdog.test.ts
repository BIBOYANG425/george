import { describe, it, expect, vi } from 'vitest'
import type { SpectrumHealth } from '../../src/adapters/spectrum-stats.js'
import {
  isWedged,
  shouldRestart,
  pruneHistory,
  watchdogTick,
  loadWatchdogConfig,
  type WatchdogConfig,
  type WatchdogDeps,
  type RestartHistory,
} from '../../src/adapters/spectrum-watchdog.js'

// A fixed "now" so all timestamps are deterministic.
const NOW = Date.parse('2026-06-22T12:00:00.000Z')
const secAgo = (s: number) => new Date(NOW - s * 1000).toISOString()

// Build a SpectrumHealth snapshot. Defaults to a healthy connected stream;
// override fields per scenario. The derived seconds fields are computed from the
// provided ISO timestamps relative to NOW so they stay internally consistent.
function health(overrides: Partial<SpectrumHealth> = {}): SpectrumHealth {
  const base: SpectrumHealth = {
    state: 'connected',
    connectedAt: secAgo(10),
    connectedDurationSeconds: 10,
    lastInboundAt: secAgo(10),
    secondsSinceInbound: 10,
    inboundCount: 5,
    reconnects: 0,
    lastError: null,
    lastErrorAt: null,
    staleInboundSeconds: 1800,
  }
  return { ...base, ...overrides }
}

const FAIL = 300
const SILENT = 10800 // 3h
const cfg = (over: Partial<WatchdogConfig> = {}): WatchdogConfig => ({
  enabled: true,
  failSeconds: FAIL,
  silentSeconds: SILENT,
  maxRestarts: 3,
  windowSeconds: 1800,
  intervalSeconds: 60,
  markerPath: '/tmp/test-marker.json',
  ...over,
})

// Thresholds object for direct isWedged calls.
const TH = { failSeconds: FAIL, silentSeconds: SILENT }

describe('spectrum-watchdog — isWedged signal A (reconnect loop cycling)', () => {
  it('healthy connected stream is NOT wedged', () => {
    expect(isWedged(health(), NOW, TH)).toBe(false)
  })

  it('error state younger than failSeconds is NOT wedged (give reconnect time)', () => {
    const h = health({
      state: 'reconnecting',
      lastError: '[upstream] Connection dropped',
      lastErrorAt: secAgo(120), // only 2 min < 5 min threshold
      connectedAt: secAgo(120),
      lastInboundAt: secAgo(120),
    })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })

  it('error/reconnecting continuously past failSeconds with no recovery IS wedged', () => {
    const h = health({
      state: 'reconnecting',
      lastError: 'CatchUpEvents UNAVAILABLE',
      lastErrorAt: secAgo(FAIL + 60), // failing for >5 min
      connectedAt: secAgo(FAIL + 600), // last good connect well outside window
      lastInboundAt: secAgo(FAIL + 600),
      secondsSinceInbound: FAIL + 600,
    })
    expect(isWedged(h, NOW, TH)).toBe(true)
  })

  it('a successful connect INSIDE the window means recovered → NOT wedged', () => {
    const h = health({
      state: 'reconnecting',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(30), // reconnected 30s ago
      lastInboundAt: secAgo(FAIL + 600),
    })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })

  it('an inbound message INSIDE the window means traffic is flowing → NOT wedged', () => {
    const h = health({
      state: 'error',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(FAIL + 600),
      lastInboundAt: secAgo(30), // received 30s ago
    })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })

  it('idle state (never connected) is NOT wedged', () => {
    const h = health({ state: 'idle', connectedAt: null, lastInboundAt: null, lastErrorAt: null })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })
})

describe('spectrum-watchdog — isWedged signal B (connected but deaf, the real incident)', () => {
  // THE false-alarm guard: a quiet beta night keeps state 'connected' with hours
  // of inbound silence. ~2h at 3am is HEALTHY, not deaf — well under the 3h
  // silentSeconds threshold — so it must NOT be wedged.
  it('quiet-but-connected (2h of inbound silence) is NOT wedged', () => {
    const h = health({
      state: 'connected',
      lastInboundAt: secAgo(2 * 60 * 60), // 2h silence — a quiet night
      secondsSinceInbound: 2 * 60 * 60,
      connectedAt: secAgo(8 * 60 * 60),
    })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })

  // The actual incident: spectrum-ts wedges internally, never throws, state stays
  // 'connected', secondsSinceInbound grows for HOURS (the 8.5h overnight deaf-out).
  // Past the 3h silentSeconds threshold → wedged.
  it('connected but silent past silentSeconds (multi-hour deaf-out) IS wedged', () => {
    const h = health({
      state: 'connected',
      lastInboundAt: secAgo(SILENT + 600), // > 3h silence
      secondsSinceInbound: SILENT + 600,
      connectedAt: secAgo(SILENT + 6000), // connected long ago, then went deaf
    })
    expect(isWedged(h, NOW, TH)).toBe(true)
  })

  it('a fresh (re)connect with no inbound yet is NOT wedged (fresh line, not deaf)', () => {
    const h = health({
      state: 'connected',
      lastInboundAt: secAgo(SILENT + 600), // old inbound...
      connectedAt: secAgo(30), // ...but just reconnected 30s ago
    })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })

  it('connected with NO inbound ever recorded is NOT wedged (never proven deaf)', () => {
    const h = health({ state: 'connected', lastInboundAt: null, secondsSinceInbound: null, connectedAt: secAgo(SILENT + 600) })
    expect(isWedged(h, NOW, TH)).toBe(false)
  })

  it('silentSeconds=0 disables signal B (connected silence never wedged)', () => {
    const h = health({
      state: 'connected',
      lastInboundAt: secAgo(SILENT + 99999), // arbitrarily long silence
      connectedAt: secAgo(SILENT + 99999),
    })
    expect(isWedged(h, NOW, { failSeconds: FAIL, silentSeconds: 0 })).toBe(false)
  })
})

describe('spectrum-watchdog — pruneHistory', () => {
  it('drops restart timestamps older than the window, keeps recent ones', () => {
    const hist: RestartHistory = {
      restarts: [NOW - 2000 * 1000, NOW - 1000 * 1000, NOW - 10 * 1000],
    }
    const pruned = pruneHistory(hist, NOW, 1800)
    expect(pruned.restarts).toEqual([NOW - 1000 * 1000, NOW - 10 * 1000])
  })
})

describe('spectrum-watchdog — shouldRestart (decision core)', () => {
  const wedged = () =>
    health({
      state: 'reconnecting',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(FAIL + 600),
      lastInboundAt: secAgo(FAIL + 600),
    })

  const baseOpts = { nowMs: NOW, failSeconds: FAIL, silentSeconds: SILENT, maxRestarts: 3, windowSeconds: 1800 }

  it('healthy → ok', () => {
    expect(shouldRestart(health(), { ...baseOpts, history: { restarts: [] } })).toBe('ok')
  })

  it('wedged with empty budget → restart', () => {
    expect(shouldRestart(wedged(), { ...baseOpts, history: { restarts: [] } })).toBe('restart')
  })

  it('wedged but already at maxRestarts within window → backoff', () => {
    const history: RestartHistory = {
      restarts: [NOW - 1000 * 1000, NOW - 500 * 1000, NOW - 60 * 1000],
    }
    expect(shouldRestart(wedged(), { ...baseOpts, history })).toBe('backoff')
  })

  it('wedged with old restarts that fall OUTSIDE the window → restart (budget reset)', () => {
    // 3 restarts but all older than the 1800s window → pruned to 0 → restart.
    const history: RestartHistory = {
      restarts: [NOW - 4000 * 1000, NOW - 3000 * 1000, NOW - 2000 * 1000],
    }
    expect(shouldRestart(wedged(), { ...baseOpts, history })).toBe('restart')
  })
})

// Build injectable deps backed by in-memory state (no real fs/process/clock).
function fakeDeps(over: {
  health: SpectrumHealth
  history?: RestartHistory
  now?: number
}): WatchdogDeps & { exited: number[]; written: RestartHistory[]; cleared: number; logs: Array<[string, string]> } {
  let history: RestartHistory = over.history ?? { restarts: [] }
  const exited: number[] = []
  const written: RestartHistory[] = []
  const logs: Array<[string, string]> = []
  let cleared = 0
  return {
    now: () => over.now ?? NOW,
    readHealth: () => over.health,
    readHistory: () => history,
    writeHistory: (h) => {
      history = h
      written.push(h)
    },
    clearHistory: () => {
      history = { restarts: [] }
      cleared += 1
    },
    exit: (code) => {
      exited.push(code)
    },
    logFn: ((level: string, event: string) => {
      logs.push([level, event])
    }) as unknown as WatchdogDeps['logFn'],
    exited,
    written,
    get cleared() {
      return cleared
    },
    logs,
  }
}

describe('spectrum-watchdog — watchdogTick (shell, no real exit)', () => {
  it('healthy connected → clears history, no exit', () => {
    const deps = fakeDeps({ health: health(), history: { restarts: [NOW - 60 * 1000] } })
    const decision = watchdogTick(cfg(), deps)
    expect(decision).toBe('ok')
    expect(deps.exited).toEqual([])
    expect(deps.cleared).toBe(1)
  })

  it('connected but DEAF past silentSeconds → restart (the real incident)', () => {
    const deaf = health({
      state: 'connected',
      lastInboundAt: secAgo(SILENT + 600),
      secondsSinceInbound: SILENT + 600,
      connectedAt: secAgo(SILENT + 6000),
    })
    const deps = fakeDeps({ health: deaf })
    const decision = watchdogTick(cfg(), deps)
    expect(decision).toBe('restart')
    expect(deps.exited).toEqual([1])
    // The restart log should tag signal B.
    expect(deps.logs).toContainEqual(['error', 'spectrum_watchdog_restart'])
    // And it must NOT have cleared the budget (it's wedged, not recovered).
    expect(deps.cleared).toBe(0)
  })

  it('wedged within budget → records a restart timestamp, logs restart, exit(1)', () => {
    const wedged = health({
      state: 'reconnecting',
      lastError: '[upstream] Connection dropped',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(FAIL + 600),
      lastInboundAt: secAgo(FAIL + 600),
    })
    const deps = fakeDeps({ health: wedged })
    const decision = watchdogTick(cfg(), deps)
    expect(decision).toBe('restart')
    expect(deps.exited).toEqual([1])
    expect(deps.written).toHaveLength(1)
    expect(deps.written[0].restarts).toHaveLength(1)
    expect(deps.logs).toContainEqual(['error', 'spectrum_watchdog_restart'])
  })

  // Crash-loop guard: budget already spent → NO exit, logs backoff, stays up.
  it('wedged but budget exhausted → backoff, NO exit, NO new restart written', () => {
    const wedged = health({
      state: 'error',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(FAIL + 600),
      lastInboundAt: secAgo(FAIL + 600),
    })
    const deps = fakeDeps({
      health: wedged,
      history: { restarts: [NOW - 1000 * 1000, NOW - 500 * 1000, NOW - 60 * 1000] },
    })
    const decision = watchdogTick(cfg(), deps)
    expect(decision).toBe('backoff')
    expect(deps.exited).toEqual([]) // critical: did NOT crash-loop
    expect(deps.written).toHaveLength(0)
    expect(deps.logs).toContainEqual(['error', 'spectrum_watchdog_backoff'])
  })

  // Simulate the full crash-loop scenario across "restarts": each tick that fires
  // appends one timestamp; after maxRestarts the next wedge backs off instead of
  // exiting. This is the end-to-end guard against an infinite restart loop.
  it('stops restarting after maxRestarts consecutive wedges in the window', () => {
    const wedged = health({
      state: 'reconnecting',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(FAIL + 600),
      lastInboundAt: secAgo(FAIL + 600),
    })
    // Shared in-memory history persists across ticks (like the marker file would
    // across process restarts).
    const deps = fakeDeps({ health: wedged })
    const c = cfg({ maxRestarts: 3 })

    expect(watchdogTick(c, deps)).toBe('restart') // 1
    expect(watchdogTick(c, deps)).toBe('restart') // 2
    expect(watchdogTick(c, deps)).toBe('restart') // 3
    expect(watchdogTick(c, deps)).toBe('backoff') // 4 → guard trips
    expect(watchdogTick(c, deps)).toBe('backoff') // stays backed off

    expect(deps.exited).toEqual([1, 1, 1]) // exactly 3 exits, never a 4th
  })

  // Recovery clears the budget: after a backoff, a healthy connect resets the
  // history so a LATER unrelated outage gets a full fresh restart allowance.
  it('recovery (healthy connect) after restarts clears the budget', () => {
    const wedged = health({
      state: 'reconnecting',
      lastErrorAt: secAgo(FAIL + 60),
      connectedAt: secAgo(FAIL + 600),
      lastInboundAt: secAgo(FAIL + 600),
    })
    const deps = fakeDeps({ health: wedged, history: { restarts: [NOW - 60 * 1000, NOW - 30 * 1000] } })
    // Now the stream recovers — swap in a healthy snapshot.
    ;(deps as { readHealth: () => SpectrumHealth }).readHealth = () => health()
    const decision = watchdogTick(cfg(), deps)
    expect(decision).toBe('ok')
    expect(deps.cleared).toBe(1)
    expect(deps.exited).toEqual([])
  })
})

describe('spectrum-watchdog — loadWatchdogConfig (default-OFF byte-identity)', () => {
  it('is disabled when the flag is unset', () => {
    const c = loadWatchdogConfig({} as NodeJS.ProcessEnv)
    expect(c.enabled).toBe(false)
  })

  it('is disabled for any non-true value (typo-safe)', () => {
    expect(loadWatchdogConfig({ SPECTRUM_WATCHDOG_ENABLED: '' } as NodeJS.ProcessEnv).enabled).toBe(false)
    expect(loadWatchdogConfig({ SPECTRUM_WATCHDOG_ENABLED: 'yes' } as NodeJS.ProcessEnv).enabled).toBe(false)
    expect(loadWatchdogConfig({ SPECTRUM_WATCHDOG_ENABLED: 'on' } as NodeJS.ProcessEnv).enabled).toBe(false)
    expect(loadWatchdogConfig({ SPECTRUM_WATCHDOG_ENABLED: 'TRUE' } as NodeJS.ProcessEnv).enabled).toBe(false)
  })

  it('enables on the literal true / 1', () => {
    expect(loadWatchdogConfig({ SPECTRUM_WATCHDOG_ENABLED: 'true' } as NodeJS.ProcessEnv).enabled).toBe(true)
    expect(loadWatchdogConfig({ SPECTRUM_WATCHDOG_ENABLED: '1' } as NodeJS.ProcessEnv).enabled).toBe(true)
  })

  it('reads tunables from env with sane defaults', () => {
    const c = loadWatchdogConfig({
      SPECTRUM_WATCHDOG_ENABLED: 'true',
      SPECTRUM_WATCHDOG_FAIL_SECONDS: '120',
      SPECTRUM_WATCHDOG_MAX_RESTARTS: '5',
      SPECTRUM_WATCHDOG_WINDOW_SECONDS: '600',
    } as NodeJS.ProcessEnv)
    expect(c.failSeconds).toBe(120)
    expect(c.maxRestarts).toBe(5)
    expect(c.windowSeconds).toBe(600)
    // unset interval + silent fall back to defaults
    expect(c.intervalSeconds).toBe(60)
    expect(c.silentSeconds).toBe(10800)
  })

  it('honors silentSeconds=0 to disable the connected-but-deaf branch', () => {
    const c = loadWatchdogConfig({
      SPECTRUM_WATCHDOG_ENABLED: 'true',
      SPECTRUM_WATCHDOG_SILENT_SECONDS: '0',
    } as NodeJS.ProcessEnv)
    expect(c.silentSeconds).toBe(0)
  })

  it('reads a custom silentSeconds', () => {
    const c = loadWatchdogConfig({
      SPECTRUM_WATCHDOG_ENABLED: 'true',
      SPECTRUM_WATCHDOG_SILENT_SECONDS: '7200',
    } as NodeJS.ProcessEnv)
    expect(c.silentSeconds).toBe(7200)
  })

  it('falls back to defaults on a non-numeric / non-positive tunable', () => {
    const c = loadWatchdogConfig({
      SPECTRUM_WATCHDOG_ENABLED: 'true',
      SPECTRUM_WATCHDOG_FAIL_SECONDS: 'abc',
      SPECTRUM_WATCHDOG_MAX_RESTARTS: '-1',
    } as NodeJS.ProcessEnv)
    expect(c.failSeconds).toBe(300)
    expect(c.maxRestarts).toBe(3)
  })
})

// Verify the DEFAULT-OFF guarantee at the timer-install seam: startSpectrumWatchdog
// with the flag off must install NO timer. (Real timer assert via the module's
// own state-inspection export.)
describe('spectrum-watchdog — default-OFF installs no timer', () => {
  it('startSpectrumWatchdog returns false and installs no timer when disabled', async () => {
    const mod = await import('../../src/adapters/spectrum-watchdog.js')
    const installed = mod.startSpectrumWatchdog(cfg({ enabled: false }))
    expect(installed).toBe(false)
    expect(mod.__watchdogTimerActive()).toBe(false)
    mod.stopSpectrumWatchdog() // no-op, must not throw
  })

  it('startSpectrumWatchdog installs + tears down a timer when enabled', async () => {
    vi.useFakeTimers()
    const mod = await import('../../src/adapters/spectrum-watchdog.js')
    const installed = mod.startSpectrumWatchdog(cfg({ enabled: true, intervalSeconds: 60 }))
    expect(installed).toBe(true)
    expect(mod.__watchdogTimerActive()).toBe(true)
    // second start is idempotent
    expect(mod.startSpectrumWatchdog(cfg({ enabled: true }))).toBe(false)
    mod.stopSpectrumWatchdog()
    expect(mod.__watchdogTimerActive()).toBe(false)
    vi.useRealTimers()
  })
})
