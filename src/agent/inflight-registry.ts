// src/agent/inflight-registry.ts
// Tracks in-flight orchestrator turns that run OUTSIDE the HTTP request/response
// lifecycle — Path B's fire-and-forget /imessage/incoming reply (src/index.ts)
// and Spectrum's flush-driven turns (src/adapters/spectrum.ts). Those turns
// resolve after the transport has already acked, so a graceful shutdown that
// exits the instant SIGTERM arrives drops replies mid-generation on every deploy.
//
// begin() before the orchestrator call, end() in a finally; shutdown calls
// drain(timeoutMs) after it stops accepting new work, which resolves either when
// the in-flight count reaches 0 or when the bounded timeout elapses (whichever
// first), so a wedged turn can never hold the process open indefinitely.
//
// Pure + side-effect free (just a counter + waiter list) so it unit-tests without
// booting the server.

export interface DrainResult {
  drained: boolean
  remaining: number
}

export interface InflightRegistry {
  begin(): void
  end(): void
  count(): number
  drain(timeoutMs: number): Promise<DrainResult>
}

export function createInflightRegistry(): InflightRegistry {
  let count = 0
  let waiters: Array<() => void> = []

  return {
    begin() {
      count++
    },
    end() {
      if (count > 0) count--
      if (count === 0 && waiters.length > 0) {
        const pending = waiters
        waiters = []
        for (const resolve of pending) resolve()
      }
    },
    count() {
      return count
    },
    drain(timeoutMs: number): Promise<DrainResult> {
      if (count === 0) return Promise.resolve({ drained: true, remaining: 0 })
      return new Promise<DrainResult>((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          resolve({ drained: false, remaining: count })
        }, timeoutMs)
        // Do not keep the event loop alive purely for the drain timeout.
        timer.unref?.()
        waiters.push(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ drained: true, remaining: 0 })
        })
      })
    },
  }
}

// Shared singleton used across the fire-and-forget transports (Path B + Spectrum)
// and drained by the process shutdown handler in src/index.ts.
export const inflightTurns = createInflightRegistry()
