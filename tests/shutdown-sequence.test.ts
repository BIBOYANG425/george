import { describe, it, expect, vi } from 'vitest'
import { runShutdownSequence } from '../src/shutdown-sequence.js'

// FIX 1 (GG1) regression: the graceful shutdown must stop inbound intake and DRAIN
// in-flight turns BEFORE the transport clients are closed, so a turn still
// generating when SIGTERM arrives can still SEND its reply over a live client.
// Booting the real Spectrum adapter in-test needs spectrum-ts (macOS-native
// bindings), so this covers the extracted ordering helper that index.ts's
// shutdown() actually runs. The real adapter's stopSpectrumIntake/closeSpectrumClient
// split is exercised indirectly (index.ts wires them into these steps).
describe('runShutdownSequence — GG1 drain-before-close ordering', () => {
  it('runs stopHttp → stopIntake → drain → closeClients in order', async () => {
    const order: string[] = []
    const steps = {
      stopHttp: () => { order.push('stopHttp') },
      stopIntake: async () => { order.push('stopIntake') },
      drain: async () => { order.push('drain'); return { drained: 0, remaining: 0 } },
      closeClients: async () => { order.push('closeClients') },
    }

    await runShutdownSequence(steps)

    expect(order).toEqual(['stopHttp', 'stopIntake', 'drain', 'closeClients'])
  })

  it('does NOT close clients until the drain promise resolves', async () => {
    const order: string[] = []
    let resolveDrain!: () => void
    const drainGate = new Promise<void>((r) => { resolveDrain = r })

    const closeClients = vi.fn(async () => { order.push('closeClients') })
    const steps = {
      stopHttp: () => {},
      stopIntake: async () => { order.push('stopIntake') },
      // Drain stays pending until we release drainGate, modelling a turn still
      // generating. closeClients must NOT have been called during this window.
      drain: async () => {
        order.push('drain:start')
        await drainGate
        order.push('drain:end')
        return { drained: 1, remaining: 0 }
      },
      closeClients,
    }

    const seqPromise = runShutdownSequence(steps)
    // Let stopIntake + drain:start run, then confirm the client is still open.
    await Promise.resolve()
    await Promise.resolve()
    expect(closeClients).not.toHaveBeenCalled()
    expect(order).toEqual(['stopIntake', 'drain:start'])

    // Turn finishes → drain resolves → only now may the client close.
    resolveDrain()
    const result = await seqPromise
    expect(closeClients).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['stopIntake', 'drain:start', 'drain:end', 'closeClients'])
    expect(result).toEqual({ drained: 1, remaining: 0 })
  })

  it('returns the drain result to the caller', async () => {
    const result = await runShutdownSequence({
      stopHttp: () => {},
      stopIntake: async () => {},
      drain: async () => ({ drained: 3, remaining: 2 }),
      closeClients: async () => {},
    })
    expect(result).toEqual({ drained: 3, remaining: 2 })
  })
})
