// tests/jobs/squad-coordinator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runCoordinatorOnce, type CoordinatorDeps } from '../../src/jobs/squad-coordinator.js'

function deps(over: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    selectWebInterest: async () => [],
    selectReminders: async () => [],
    selectRefills: async () => [],
    selectCompletions: async () => [],
    handleFor: async () => 'h',
    sendProactive: vi.fn(async () => {}),
    runFanout: vi.fn(async () => {}),
    markBrokered: vi.fn(async () => {}),
    markReminderSent: vi.fn(async () => {}),
    clearNeedsRefill: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    nowHourLA: () => 14, // daytime, not deep-quiet
    deepQuiet: { start: 2, end: 8 },
    ...over,
  }
}

describe('runCoordinatorOnce', () => {
  it('① brokers a web-interest ping once, then stamps brokered_at', async () => {
    const send = vi.fn(async () => {})
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: 'K-town' }],
      sendProactive: send, markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0][1])).toContain('帮你报名')
    expect(markBrokered).toHaveBeenCalledWith('pg1')
  })

  it('② reminds every member of a post, then stamps the post once', async () => {
    const send = vi.fn(async () => {})
    const markReminderSent = vi.fn(async () => {})
    const d = deps({
      selectReminders: async () => [{ post_id: 'po1', poster_name: '学长', category: '自习', location: 'Leavey', member_student_ids: ['a', 'b'] }],
      sendProactive: send, markReminderSent,
    })
    await runCoordinatorOnce(d)
    expect(send).toHaveBeenCalledTimes(2)
    expect(String(send.mock.calls[0][1])).toContain('还来吗')
    expect(markReminderSent).toHaveBeenCalledWith('po1')
  })

  it('③ refills a dropped post via runFanout then clears needs_refill', async () => {
    const runFanout = vi.fn(async () => {})
    const clearNeedsRefill = vi.fn(async () => {})
    const d = deps({ selectRefills: async () => ['po2'], runFanout, clearNeedsRefill })
    await runCoordinatorOnce(d)
    expect(runFanout).toHaveBeenCalledWith('po2')
    expect(clearNeedsRefill).toHaveBeenCalledWith('po2')
  })

  it('④ marks an expired post completed', async () => {
    const markCompleted = vi.fn(async () => {})
    const d = deps({ selectCompletions: async () => ['po3'], markCompleted })
    await runCoordinatorOnce(d)
    expect(markCompleted).toHaveBeenCalledWith('po3')
  })

  it('skips broker/reminder sends in deep-quiet hours and does NOT stamp', async () => {
    const send = vi.fn(async () => {})
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      nowHourLA: () => 3, // inside 2-8 deep quiet
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: null }],
      sendProactive: send, markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(send).not.toHaveBeenCalled()
    expect(markBrokered).not.toHaveBeenCalled()
  })

  it('does NOT stamp when the send fails (retried next tick)', async () => {
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: null }],
      sendProactive: async () => { throw new Error('no_spectrum_connection') },
      markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(markBrokered).not.toHaveBeenCalled()
  })

  it('skips a recipient with no channel (handleFor null) without stamping', async () => {
    const send = vi.fn(async () => {})
    const markBrokered = vi.fn(async () => {})
    const d = deps({
      handleFor: async () => null,
      selectWebInterest: async () => [{ ping_id: 'pg1', recipient_student_id: 's1', category: '拼车', location: null }],
      sendProactive: send, markBrokered,
    })
    await runCoordinatorOnce(d)
    expect(send).not.toHaveBeenCalled()
    expect(markBrokered).not.toHaveBeenCalled()
  })
})
