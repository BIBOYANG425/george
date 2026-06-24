// tests/jobs/shipping-notifier.test.ts
//
// Pins the shipping-notifier behaviour — especially the bugs an independent
// (Codex) adversarial review caught, so they cannot silently regress:
//   • opt-out students are skipped, never messaged
//   • bad-news kinds (lost/returned/disputed) are held ~15 min, then sent
//   • unknown kind / no platform id / incomplete pickup payload → skipped
//   • pickup times render in America/Los_Angeles, not the server TZ (Codex #7)
//   • delivery failure → 'failed', not 'sent'
//   • the */5 cron can't re-enter while a tick is draining (in-flight guard)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted spies so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  getPending: vi.fn(),
  markStale: vi.fn(async () => 0),
  markSent: vi.fn(async () => {}),
  markSkipped: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
  log: vi.fn(),
}))

vi.mock('../../src/db/shipping-notifications.js', () => ({
  getPendingShippingNotifications: h.getPending,
  markStaleNotificationsSkipped: h.markStale,
  markShippingNotificationSent: h.markSent,
  markShippingNotificationSkipped: h.markSkipped,
  markShippingNotificationFailed: h.markFailed,
}))
vi.mock('../../src/adapters/send-message.js', () => ({
  sendPlatformMessage: h.send,
}))
vi.mock('../../src/observability/logger.js', () => ({ log: h.log }))

import {
  sendPendingShippingNotifications,
  messageForKind,
} from '../../src/jobs/shipping-notifier.js'

const student = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  wechat_open_id: null,
  imessage_id: '+15551234567',
  name: 'Test',
  shipping_notif_opt_out: false,
  ...over,
})

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  kind: 'arrived_us',
  payload: {},
  created_at: new Date().toISOString(),
  students: student(),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.markStale.mockResolvedValue(0)
})

describe('messageForKind', () => {
  it('returns null for an unknown kind (→ skipped, never sent)', () => {
    expect(messageForKind('totally_unknown')).toBeNull()
  })

  it('has non-empty static copy for every base kind', () => {
    for (const k of ['received_cn', 'in_transit', 'arrived_us', 'picked_up_thanks']) {
      const m = messageForKind(k)
      expect(typeof m).toBe('string')
      expect((m as string).length).toBeGreaterThan(0)
    }
  })

  it('templates pickup_open from the enqueued payload', () => {
    const msg = messageForKind('pickup_open', {
      member_id: 'BIA-123',
      pickup_location: 'THH 301',
      pickup_starts_at: '2026-06-25T20:00:00Z',
      pickup_ends_at: '2026-06-25T22:00:00Z',
    }) as string
    expect(msg).toContain('BIA-123')
    expect(msg).toContain('THH 301')
  })

  it('renders pickup times in LA timezone, not the server TZ (Codex #7)', () => {
    // 05:00Z on 6/25 = 22:00 on 6/24 in LA (PDT, -7) — different day, so LA≠UTC.
    const ends = '2026-06-25T05:00:00Z'
    const opts = {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    } as const
    const la = new Date(ends).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles', ...opts })
    const utc = new Date(ends).toLocaleString('zh-CN', { timeZone: 'UTC', ...opts })
    expect(la).not.toBe(utc) // sanity: this timestamp actually distinguishes the zones
    const msg = messageForKind('pickup_reminder', {
      member_id: 'X',
      pickup_location: 'Y',
      pickup_ends_at: ends,
    }) as string
    expect(msg).toContain(la) // notifier rendered LA time
    expect(msg).not.toContain(utc) // and NOT the UTC time
  })

  it('bad-news copy is neutral and points to a human', () => {
    expect(messageForKind('lost')).toMatch(/运营|联系|reach out/i)
  })
})

describe('sendPendingShippingNotifications', () => {
  it('sends the happy-path row via iMessage and marks it sent', async () => {
    h.getPending.mockResolvedValue([row({ kind: 'arrived_us' })])
    await sendPendingShippingNotifications()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(
      'imessage',
      '+15551234567',
      expect.stringContaining('美国'),
    )
    expect(h.markSent).toHaveBeenCalledWith('n1')
  })

  it('skips an opted-out student without messaging them', async () => {
    h.getPending.mockResolvedValue([
      row({ students: student({ shipping_notif_opt_out: true }) }),
    ])
    await sendPendingShippingNotifications()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.markSkipped).toHaveBeenCalledWith('n1', 'opted_out')
  })

  it('skips a kind with no copy', async () => {
    h.getPending.mockResolvedValue([row({ kind: 'mystery_kind' })])
    await sendPendingShippingNotifications()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.markSkipped).toHaveBeenCalledWith('n1', 'no_copy_for_kind')
  })

  it('skips when the student has no reachable platform id', async () => {
    h.getPending.mockResolvedValue([
      row({ students: student({ imessage_id: null, wechat_open_id: null }) }),
    ])
    await sendPendingShippingNotifications()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.markSkipped).toHaveBeenCalledWith('n1', 'no_platform_id')
  })

  it('skips a pickup row missing member_id/location instead of sending blanks (Codex #10)', async () => {
    h.getPending.mockResolvedValue([row({ kind: 'pickup_open', payload: {} })])
    await sendPendingShippingNotifications()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.markSkipped).toHaveBeenCalledWith('n1', 'incomplete_pickup_payload')
  })

  it('holds a bad-news row younger than 15 min (left pending, not sent, not skipped)', async () => {
    h.getPending.mockResolvedValue([
      row({ id: 'bad1', kind: 'lost', created_at: new Date().toISOString() }),
    ])
    await sendPendingShippingNotifications()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.markSkipped).not.toHaveBeenCalled()
    expect(h.markSent).not.toHaveBeenCalled()
  })

  it('sends a bad-news row once it is older than 15 min', async () => {
    h.getPending.mockResolvedValue([
      row({
        id: 'bad2',
        kind: 'lost',
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      }),
    ])
    await sendPendingShippingNotifications()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.markSent).toHaveBeenCalledWith('bad2')
  })

  it('marks failed (never sent) when delivery throws', async () => {
    h.getPending.mockResolvedValue([row()])
    h.send.mockRejectedValueOnce(new Error('imessage down'))
    await sendPendingShippingNotifications()
    expect(h.markFailed).toHaveBeenCalledWith('n1', 'imessage down')
    expect(h.markSent).not.toHaveBeenCalled()
  })

  it('falls back to the other channel when the primary send throws', async () => {
    h.getPending.mockResolvedValue([
      row({ students: student({ wechat_open_id: 'wx-1', imessage_id: '+1555' }) }),
    ])
    // primary = WeChat (throws, e.g. 48h-window errcode) → fall back to iMessage
    h.send
      .mockRejectedValueOnce(new Error('wechat errcode 45015'))
      .mockResolvedValueOnce(undefined)
    await sendPendingShippingNotifications()
    expect(h.send).toHaveBeenNthCalledWith(1, 'wechat', 'wx-1', expect.any(String))
    expect(h.send).toHaveBeenNthCalledWith(2, 'imessage', '+1555', expect.any(String))
    expect(h.markSent).toHaveBeenCalledWith('n1')
    expect(h.markFailed).not.toHaveBeenCalled()
  })

  it('marks failed only after ALL channels fail', async () => {
    h.getPending.mockResolvedValue([
      row({ students: student({ wechat_open_id: 'wx-1', imessage_id: '+1555' }) }),
    ])
    h.send.mockRejectedValue(new Error('both channels down'))
    await sendPendingShippingNotifications()
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(h.markFailed).toHaveBeenCalledWith('n1', 'both channels down')
    expect(h.markSent).not.toHaveBeenCalled()
  })

  it('in-flight guard: a second run while one is draining bails out (Codex #3)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    // First tick blocks inside getPending until we release it.
    h.getPending.mockImplementationOnce(async () => {
      await gate
      return []
    })
    const first = sendPendingShippingNotifications() // sets notifierRunning=true, blocks
    await Promise.resolve()
    await sendPendingShippingNotifications() // re-entry → should bail immediately
    expect(h.getPending).toHaveBeenCalledTimes(1) // second never reached getPending
    expect(h.log).toHaveBeenCalledWith(
      'warn',
      'shipping_notifier_overlap_skipped',
      expect.anything(),
    )
    release()
    await first
  })
})
