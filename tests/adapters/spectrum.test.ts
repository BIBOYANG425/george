import { describe, it, expect, vi } from 'vitest'
import { runSpectrumLoop } from '../../src/adapters/spectrum.js'
import type { SpectrumClient, InboundMessage, ReplyHandle } from '../../src/adapters/spectrum-client.js'

function fakeClient(msgs: InboundMessage[]): { client: SpectrumClient; sent: string[] } {
  const sent: string[] = []
  const reply: ReplyHandle = {
    sendText: async (t) => { sent.push(t) },
    sendAttachment: async () => {},
  }
  const client: SpectrumClient = {
    async *messages() { for (const m of msgs) yield [reply, m] as const },
    getLocation: async () => null,
    close: async () => {},
  }
  return { client, sent }
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: 'iMessage', senderId: '+15551234567', contentType: 'text',
  text: 'hi', messageId: 'm1', ...over,
})

describe('runSpectrumLoop', () => {
  it('routes a text message to the handler once', async () => {
    const { client } = fakeClient([msg({ text: 'yo learn' })])
    const handle = vi.fn(async () => 'reply text')
    await runSpectrumLoop(client, { handleText: handle, handleLocation: vi.fn() })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('+15551234567', 'yo learn', expect.anything())
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
})
