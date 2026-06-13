import { describe, it, expect, vi } from 'vitest'
import { runSpectrumLoop } from '../../src/adapters/spectrum.js'
import { sendWithRetry, redactHandle, isTransientSendError } from '../../src/adapters/spectrum-client.js'
import type { SpectrumClient, InboundMessage, ReplyHandle } from '../../src/adapters/spectrum-client.js'

function fakeClient(msgs: InboundMessage[]): { client: SpectrumClient; sent: string[]; typing: string[] } {
  const sent: string[] = []
  const typing: string[] = []
  const reply: ReplyHandle = {
    sendText: async (t) => { sent.push(t) },
    sendAttachment: async () => {},
    startTyping: async () => { typing.push('start') },
    stopTyping: async () => { typing.push('stop') },
  }
  const client: SpectrumClient = {
    async *messages() { for (const m of msgs) yield [reply, m] as const },
    getLocation: async () => null,
    close: async () => {},
  }
  return { client, sent, typing }
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: 'iMessage', senderId: '+15551234567', contentType: 'text',
  text: 'hi', messageId: 'm1', ...over,
})

describe('redactHandle', () => {
  it('masks all but the last 4 chars of a phone handle', () => {
    expect(redactHandle('+15551234567')).toBe('********4567')
  })
  it('does not leak the full handle', () => {
    expect(redactHandle('+15551234567')).not.toContain('5551')
  })
  it('fully masks short handles', () => {
    expect(redactHandle('123')).toBe('***')
  })
  it('returns ? for empty/undefined', () => {
    expect(redactHandle('')).toBe('?')
    expect(redactHandle(undefined)).toBe('?')
    expect(redactHandle(null)).toBe('?')
  })
})

describe('sendWithRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn(async () => {})
    await sendWithRetry(fn, { backoffMs: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('retries once after a transient failure then succeeds', async () => {
    let n = 0
    const fn = vi.fn(async () => { if (n++ === 0) throw new Error('[upstream] Connection dropped') })
    await sendWithRetry(fn, { backoffMs: 0 })
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('exhausts attempts on a persistent transient failure then throws', async () => {
    const fn = vi.fn(async () => { throw new Error('[upstream] Connection dropped') })
    await expect(sendWithRetry(fn, { backoffMs: 0 })).rejects.toThrow('Connection dropped')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('does NOT retry a non-transient error (avoids duplicate sends)', async () => {
    // space.send has no dedupe key, so resending a non-transport failure could
    // duplicate the bubble — these throw on the first attempt.
    const fn = vi.fn(async () => { throw new Error('message too long') })
    await expect(sendWithRetry(fn, { backoffMs: 0 })).rejects.toThrow('message too long')
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('honors a custom shouldRetry predicate', async () => {
    let n = 0
    const fn = vi.fn(async () => { if (n++ === 0) throw new Error('whatever') })
    await sendWithRetry(fn, { backoffMs: 0, shouldRetry: () => true })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('isTransientSendError', () => {
  it('matches known transient transport drops', () => {
    for (const m of [
      '[upstream] Connection dropped',
      'ECONNRESET',
      'socket hang up',
      'stream closed',
      'UNAVAILABLE: 14',
      'deadline exceeded',
      'HTTP 503',
    ]) {
      expect(isTransientSendError(new Error(m))).toBe(true)
    }
  })
  it('does not match application/validation errors', () => {
    for (const m of ['message too long', 'ValidationError', 'AuthenticationError', 'forbidden']) {
      expect(isTransientSendError(new Error(m))).toBe(false)
    }
  })
  it('tolerates non-Error throwables', () => {
    expect(isTransientSendError('connection dropped')).toBe(true)
    expect(isTransientSendError(null)).toBe(false)
  })
})

describe('runSpectrumLoop', () => {
  it('routes a text message to the handler once', async () => {
    const { client } = fakeClient([msg({ text: 'yo learn' })])
    const handle = vi.fn(async () => 'reply text')
    await runSpectrumLoop(client, { handleText: handle, handleLocation: vi.fn() })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('+15551234567', 'yo learn', expect.anything(), expect.anything())
  })

  it('dedups a repeated messageId', async () => {
    const { client } = fakeClient([msg({ messageId: 'dup' }), msg({ messageId: 'dup' })])
    const handle = vi.fn(async () => null)
    await runSpectrumLoop(client, { handleText: handle, handleLocation: vi.fn() })
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('sends the handler reply back through the space', async () => {
    const { client, sent } = fakeClient([msg()])
    await runSpectrumLoop(client, { handleText: async () => 'pong', handleLocation: vi.fn() })
    expect(sent).toEqual(['pong'])
  })

  it('sends nothing when the handler returns null (filtered)', async () => {
    const { client, sent } = fakeClient([msg()])
    await runSpectrumLoop(client, { handleText: async () => null, handleLocation: vi.fn() })
    expect(sent).toEqual([])
  })

  it('shows a typing indicator around the handler turn (start before, stop after)', async () => {
    const { client, typing } = fakeClient([msg()])
    const order: string[] = []
    await runSpectrumLoop(client, {
      handleText: async () => { order.push('handle'); return 'pong' },
      handleLocation: vi.fn(),
    })
    expect(typing).toEqual(['start', 'stop'])
  })

  it('sends a "still thinking" nudge before the reply when the turn runs long', async () => {
    const { client, sent } = fakeClient([msg()])
    await runSpectrumLoop(
      client,
      {
        handleText: async () => {
          await new Promise((r) => setTimeout(r, 30))
          return 'real reply'
        },
        handleLocation: vi.fn(),
      },
      { interimDelayMs: 0 }, // fire the nudge immediately
    )
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBeTruthy() // the interim nudge
    expect(sent[1]).toBe('real reply')
  })

  it('does NOT send a nudge for a fast turn', async () => {
    const { client, sent } = fakeClient([msg()])
    await runSpectrumLoop(client, {
      handleText: async () => 'quick',
      handleLocation: vi.fn(),
    }) // default 9s interim — instant handler resolves first
    expect(sent).toEqual(['quick'])
  })

  it('stops typing even when the handler returns null or throws', async () => {
    const a = fakeClient([msg()])
    await runSpectrumLoop(a.client, { handleText: async () => null, handleLocation: vi.fn() })
    expect(a.typing).toEqual(['start', 'stop'])

    const b = fakeClient([msg()])
    await runSpectrumLoop(b.client, { handleText: async () => { throw new Error('boom') }, handleLocation: vi.fn() })
    expect(b.typing).toEqual(['start', 'stop'])
  })

  it('debounces a burst from one sender into a single handler call', async () => {
    const { client } = fakeClient([
      msg({ messageId: 'a', text: 'first' }),
      msg({ messageId: 'b', text: 'second' }),
    ])
    const handle = vi.fn(async () => null)
    await runSpectrumLoop(client, { handleText: handle, handleLocation: vi.fn() }, { debounceMs: 0 })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0][1]).toBe('first\nsecond')
  })

  it('aborts the in-flight turn when a rapid follow-up lands mid-turn (replies only to the latest)', async () => {
    const sent: string[] = []
    const reply: ReplyHandle = {
      sendText: async (t) => { sent.push(t) },
      sendAttachment: async () => {},
      startTyping: async () => {},
      stopTyping: async () => {},
    }
    let turnStarted!: () => void
    const started = new Promise<void>((r) => { turnStarted = r })
    let firstAborted = false

    const handleText = async (
      _u: string, text: string, _r: ReplyHandle, ac?: AbortController,
    ): Promise<string | null> => {
      if (text === 'first') {
        turnStarted() // the first turn is now running
        await new Promise<void>((resolve, reject) => {
          if (ac?.signal.aborted) return reject(new Error('aborted'))
          ac?.signal.addEventListener('abort', () => { firstAborted = true; reject(new Error('aborted')) })
          setTimeout(resolve, 2000) // would finish in 2s if never superseded
        })
        return 'REPLY-FIRST'
      }
      return 'REPLY-SECOND'
    }

    const client: SpectrumClient = {
      async *messages() {
        yield [reply, msg({ messageId: 'a', text: 'first' })] as const
        await started // hold the 2nd message until the 1st turn is actually running
        yield [reply, msg({ messageId: 'b', text: 'second' })] as const
      },
      getLocation: async () => null,
      close: async () => {},
    }

    await runSpectrumLoop(
      client,
      { handleText, handleLocation: vi.fn() },
      { debounceMs: 50, interimDelayMs: 60_000 },
    )

    expect(firstAborted).toBe(true)               // the stale turn was cancelled
    expect(sent).toContain('REPLY-SECOND')        // the latest intent is answered
    expect(sent).not.toContain('REPLY-FIRST')     // and the superseded reply never goes out
  })
})
