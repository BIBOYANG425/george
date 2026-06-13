import { describe, expect, it, vi } from 'vitest'
import { runPingFanout, inQuietHours, type PingDeps } from '../../src/services/squad-ping-engine'

const CAND = (id: string, score = 0.05) => ({ student_id: id, rrf_score: score, semantic_sim: 0.7, tag_overlap: 1, matched_tags: ['hiking'], best_facet: 'hiking' })

function deps(over: Partial<PingDeps> = {}): PingDeps & { sent: string[]; rows: any[] } {
  const sent: string[] = []
  const rows: any[] = []
  return {
    matchUsers: vi.fn(async () => [CAND('s1'), CAND('s2', 0.04)]),
    loadPrefs: vi.fn(async (id: string) => ({ student_id: id, pings_enabled: true, weekly_ping_cap: 3, quiet_start_hour: 23, quiet_end_hour: 9, allowed_categories: null, channel: 'imessage' })),
    countSentThisWeek: vi.fn(async () => 0),
    handleFor: vi.fn(async (id: string) => `+1555000${id.slice(-1)}`),
    recordPing: vi.fn(async (row: any) => { rows.push(row) }),
    deliver: vi.fn(async (handle: string) => { sent.push(handle) }),
    composePing: vi.fn(() => ['诶 有人组了局', '想去我帮你报名']),
    nowHourLA: () => 14,
    maxPings: 5,
    sent, rows,
    ...over,
  } as never
}

describe('runPingFanout', () => {
  it('sends to matched candidates and records sent rows', async () => {
    const d = deps()
    const res = await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(2)
    expect(d.rows.every((r) => r.status === 'sent')).toBe(true)
    expect(res).toEqual({ sent: 2, suppressed: 0 })
  })
  it('INVARIANT #2a: the (cap)th+1 ping is recorded suppressed_cap, not sent', async () => {
    const d = deps({ countSentThisWeek: vi.fn(async () => 3) })
    await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(0)
    expect(d.rows.every((r) => r.status === 'suppressed_cap')).toBe(true)
  })
  it('INVARIANT #2b: quiet hours suppress with status, never silently', async () => {
    const d = deps({ nowHourLA: () => 2 })
    await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(0)
    expect(d.rows.every((r) => r.status === 'suppressed_quiet_hours')).toBe(true)
  })
  it('INVARIANT #3: no handle → suppressed_no_channel row, never nothing', async () => {
    const d = deps({ handleFor: vi.fn(async () => null) })
    await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(0)
    expect(d.rows).toHaveLength(2)
    expect(d.rows.every((r) => r.status === 'suppressed_no_channel')).toBe(true)
  })
  it('category scoping: allowed_categories excludes the post category → suppressed_muted', async () => {
    const d = deps({
      loadPrefs: vi.fn(async (id: string) => ({ student_id: id, pings_enabled: true, weekly_ping_cap: 3, quiet_start_hour: 23, quiet_end_hour: 9, allowed_categories: ['自习'], channel: 'imessage' })),
      postCategory: '其它',
    } as never)
    await runPingFanout('post-1', d)
    expect(d.rows.every((r) => r.status === 'suppressed_muted')).toBe(true)
  })
  it('delivery failure → row recorded suppressed_no_channel (delivery is at-most-once, accounted)', async () => {
    const d = deps({ deliver: vi.fn(async () => { throw new Error('queue down') }) })
    await runPingFanout('post-1', d)
    expect(d.rows.every((r) => r.status === 'suppressed_no_channel')).toBe(true)
  })
  it('respects maxPings ordering by score', async () => {
    const d = deps({ maxPings: 1 })
    await runPingFanout('post-1', d)
    expect(d.sent).toEqual(['+1555000' + '1'])
  })
})

describe('inQuietHours', () => {
  it('handles the wrap-around window 23→9', () => {
    expect(inQuietHours(2, 23, 9)).toBe(true)
    expect(inQuietHours(23, 23, 9)).toBe(true)
    expect(inQuietHours(14, 23, 9)).toBe(false)
    expect(inQuietHours(9, 23, 9)).toBe(false)
  })
})
