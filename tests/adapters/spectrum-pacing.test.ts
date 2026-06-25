// tests/adapters/spectrum-pacing.test.ts
//
// Pacing & Delivery v1, Task 4 — the integration tests for wiring the durable
// paced delivery into the Spectrum send path behind GEORGE_PACING_ENABLED.
//
// Three layers, all deterministic and network-free:
//  1. stageSendPaced — bubble 0 inline via reply.sendText; bubbles 1..N-1 handed
//     to the scheduler.schedule spy; abort + single-bubble edge cases.
//  2. scheduler/drainer — over the in-memory db: schedule persists [1..N-1] only,
//     drainDue sends them in order, cancelPending clears the pending tail.
//  3. runSpectrumLoop — OFF-path equivalence (no scheduler touched) and the
//     ON-path cancelPending-on-fresh-inbound supersede.

import { describe, it, expect, vi } from 'vitest'
import { stageSendPaced } from '../../src/adapters/spectrum-stages.js'
import {
  createOutgoingScheduler,
  createInMemoryOutgoingSchedulerDB,
} from '../../src/adapters/outgoing-scheduler.js'
import { runSpectrumLoop } from '../../src/adapters/spectrum.js'
import type { SpectrumClient, InboundMessage, ReplyHandle } from '../../src/adapters/spectrum-client.js'

function fakeReply() {
  const sent: string[] = []
  const reply: ReplyHandle = {
    sendText: async (t) => { sent.push(t) },
    sendAttachment: async () => {},
    react: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  }
  return { reply, sent }
}

function fakeClient(msgs: InboundMessage[]): { client: SpectrumClient; sent: string[] } {
  const sent: string[] = []
  const reply: ReplyHandle = {
    sendText: async (t) => { sent.push(t) },
    sendAttachment: async () => {},
    react: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  }
  const client: SpectrumClient = {
    async *messages() { for (const m of msgs) yield [reply, m] as const },
    getLocation: async () => null,
    sendProactive: async () => {},
    close: async () => {},
  }
  return { client, sent }
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: 'iMessage', senderId: '+15551234567', contentType: 'text',
  text: 'hi', messageId: 'm1', ...over,
})

// ── 1. stageSendPaced ───────────────────────────────────────────────────────
describe('stageSendPaced', () => {
  it('sends bubble 0 inline and schedules the FULL parts array for a 3-bubble reply', async () => {
    const { reply, sent } = fakeReply()
    const schedule = vi.fn(async () => {})
    const ac = new AbortController()
    await stageSendPaced('a\n\nb\n\nc', reply, '+1555', ac, { schedule })
    // Bubble 0 inline, nothing else inline.
    expect(sent).toEqual(['a'])
    // schedule() takes the FULL array (it persists [1..N-1] itself).
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledWith('+1555', ['a', 'b', 'c'])
  })

  it('sends a single-bubble reply inline and does NOT schedule', async () => {
    const { reply, sent } = fakeReply()
    const schedule = vi.fn(async () => {})
    const ac = new AbortController()
    await stageSendPaced('just one line', reply, '+1555', ac, { schedule })
    expect(sent).toEqual(['just one line'])
    expect(schedule).not.toHaveBeenCalled()
  })

  it('sends nothing and schedules nothing when the turn was already aborted', async () => {
    const { reply, sent } = fakeReply()
    const schedule = vi.fn(async () => {})
    const ac = new AbortController()
    ac.abort()
    await stageSendPaced('a\n\nb\n\nc', reply, '+1555', ac, { schedule })
    expect(sent).toEqual([])
    expect(schedule).not.toHaveBeenCalled()
  })

  it('sends nothing for an empty reply (no parts)', async () => {
    const { reply, sent } = fakeReply()
    const schedule = vi.fn(async () => {})
    const ac = new AbortController()
    await stageSendPaced('   ', reply, '+1555', ac, { schedule })
    expect(sent).toEqual([])
    expect(schedule).not.toHaveBeenCalled()
  })
})

// ── 2. scheduler + drainer over the in-memory db ────────────────────────────
describe('scheduler/drainer integration (in-memory db, no network)', () => {
  it('schedules the tail and drains bubbles 1..N-1 in order (NOT bubble 0)', async () => {
    const scheduler = createOutgoingScheduler(createInMemoryOutgoingSchedulerDB())
    await scheduler.schedule('+1555', ['a', 'b', 'c'])
    const sentOrder: string[] = []
    const send = vi.fn(async (_h: string, content: string) => { sentOrder.push(content) })
    // A far-future "now" makes every persisted send_at due.
    const n = await scheduler.drainDue(Date.now() + 60_000, send)
    expect(n).toBe(2)
    expect(sentOrder).toEqual(['b', 'c']) // bubble 0 ('a') was sent inline, never persisted
  })

  it('cancelPending clears the pending tail so a subsequent drain sends nothing', async () => {
    const scheduler = createOutgoingScheduler(createInMemoryOutgoingSchedulerDB())
    await scheduler.schedule('+1555', ['a', 'b', 'c'])
    const deleted = await scheduler.cancelPending('+1555')
    expect(deleted).toBe(2) // the two persisted tail bubbles
    const send = vi.fn(async () => {})
    const n = await scheduler.drainDue(Date.now() + 60_000, send)
    expect(n).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})

// ── 3. runSpectrumLoop wiring ───────────────────────────────────────────────
describe('runSpectrumLoop — pacing wiring', () => {
  it('OFF path: never touches a scheduler (send path unchanged)', async () => {
    const { client, sent } = fakeClient([msg({ text: 'yo' })])
    const scheduler = { schedule: vi.fn(async () => {}), cancelPending: vi.fn(async () => 0) }
    // pacingEnabled omitted (default-OFF): scheduler must be ignored entirely.
    await runSpectrumLoop(
      client,
      { handleText: async () => 'a\n\nb\n\nc', handleLocation: vi.fn() },
      { scheduler, debounceMs: 0, interimDelayMs: 60_000 },
    )
    // All bubbles went out inline via the OFF-path stageSend.
    expect(sent).toEqual(['a', 'b', 'c'])
    expect(scheduler.schedule).not.toHaveBeenCalled()
    expect(scheduler.cancelPending).not.toHaveBeenCalled()
  })

  it('ON path: bubble 0 inline + tail scheduled; a fresh inbound cancels pending bubbles', async () => {
    // Two distinct senders so the second inbound is a genuine fresh message (not
    // coalesced into the first sender's burst). Each triggers a cancelPending.
    const { client, sent } = fakeClient([
      msg({ senderId: '+1aaa', messageId: 'a', text: 'one' }),
      msg({ senderId: '+1bbb', messageId: 'b', text: 'two' }),
    ])
    const schedule = vi.fn(async () => {})
    const cancelPending = vi.fn(async () => 0)
    await runSpectrumLoop(
      client,
      { handleText: async () => 'x\n\ny', handleLocation: vi.fn() },
      { scheduler: { schedule, cancelPending }, pacingEnabled: true, debounceMs: 0, interimDelayMs: 60_000 },
    )
    // Each sender: bubble 0 ('x') inline, tail ['x','y'] handed to schedule().
    expect(sent.filter((s) => s === 'x')).toHaveLength(2)
    expect(sent).not.toContain('y') // 'y' is deferred to the scheduler, never inline
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(schedule).toHaveBeenCalledWith('+1aaa', ['x', 'y'])
    expect(schedule).toHaveBeenCalledWith('+1bbb', ['x', 'y'])
    // cancelPending fires once per fresh inbound (the supersede check).
    expect(cancelPending).toHaveBeenCalledWith('+1aaa')
    expect(cancelPending).toHaveBeenCalledWith('+1bbb')
  })

  it('ON path: a cancelPending rejection never throws into the loop', async () => {
    const { client, sent } = fakeClient([msg({ text: 'yo' })])
    const schedule = vi.fn(async () => {})
    const cancelPending = vi.fn(async () => { throw new Error('db down') })
    // Must not reject — the cancel is fire-and-forget with .catch(()=>{}).
    await expect(
      runSpectrumLoop(
        client,
        { handleText: async () => 'hello', handleLocation: vi.fn() },
        { scheduler: { schedule, cancelPending }, pacingEnabled: true, debounceMs: 0, interimDelayMs: 60_000 },
      ),
    ).resolves.toBeUndefined()
    // Single bubble: sent inline, no schedule.
    expect(sent).toEqual(['hello'])
    expect(schedule).not.toHaveBeenCalled()
  })
})
