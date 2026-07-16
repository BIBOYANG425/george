import {
  getPendingShippingNotifications,
  markStaleNotificationsSkipped,
  markShippingNotificationSent,
  markShippingNotificationSkipped,
  markShippingNotificationFailed,
} from '../db/shipping-notifications.js'
import { sendPlatformMessage } from '../adapters/send-message.js'
import { log } from '../observability/logger.js'
import { config } from '../config.js'

// Pending rows are fetched LIMIT-bounded per tick; hitting this many means the
// backlog is deeper than one tick can drain. Mirrors the db-layer LIMIT.
const QUEUE_TICK_LIMIT = 100

// Static bilingual copy per notification kind. Deterministic (no LLM) — shipping
// status updates are transactional, not conversational. Pickup kinds template
// the enqueued payload (location/window/member_id). Bad-news kinds stay neutral
// and point to a human (an officer reaches out; see the 15-min delay below).
type MessageFn = (p: Record<string, unknown>) => string

function fmtDate(v: unknown): string {
  if (typeof v !== 'string') return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('zh-CN', {
        // Pickup is at USC — render in LA time regardless of server TZ (Codex #7).
        timeZone: 'America/Los_Angeles',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

function fmtWindow(p: Record<string, unknown>): string {
  const s = fmtDate(p.pickup_starts_at)
  const e = fmtDate(p.pickup_ends_at)
  if (s && e) return `，时间 ${s}–${e}`
  if (e) return `，截止 ${e}`
  return ''
}

const MESSAGES: Record<string, string | MessageFn> = {
  received_cn:
    '📦 你的包裹已到中国仓库，等待打包发货 / Your parcel arrived at the China warehouse.',
  in_transit:
    '✈️ 你的包裹已发往美国 / Your parcel is on its way to the US.',
  arrived_us:
    '🇺🇸 你的包裹已到美国，请留意取件通知 / Your parcel landed in the US — pickup info coming.',
  picked_up_thanks:
    '✅ 包裹已取件，感谢使用 BIA 集运 / Picked up. Thanks for using BIA shipping!',
  pickup_open: (p) =>
    `🎉 可取件啦！地点：${p.pickup_location ?? '见群通知'}${fmtWindow(p)}。带上 member ID ${p.member_id ?? ''}。\nReady for pickup! Bring your member ID.`,
  pickup_reminder: (p) =>
    `⏰ 别忘了取件${p.pickup_ends_at ? `，截止 ${fmtDate(p.pickup_ends_at)}` : ''}（${p.pickup_location ?? '见群通知'}）。过期可能要重新安排。\nReminder: please pick up before it closes.`,
  orphan_received:
    '📦 仓库收到一个未认领的包裹。如果是你的，去 uscbia.com/shipping 绑定 member ID 认领。\nAn unclaimed parcel arrived — claim it at uscbia.com/shipping.',
  lost:
    '⚠️ 你的一个包裹出现异常（疑似丢失），BIA 运营会尽快联系你处理。\nOne of your parcels has an issue — our team will reach out.',
  returned:
    '↩️ 你的一个包裹被退回，BIA 运营会联系你说明后续。\nA parcel was returned — our team will contact you.',
  disputed:
    '❗ 你的一个包裹状态有争议，正在核实，会尽快给你答复。\nA parcel is under review — we will follow up shortly.',
}

export function messageForKind(
  kind: string,
  payload?: Record<string, unknown> | null,
): string | null {
  const m = MESSAGES[kind]
  if (m == null) return null
  return typeof m === 'function' ? m(payload ?? {}) : m
}

// Bad-news kinds get a head start: hold them ~15 min so an officer can reach out
// personally before the automated "有异常" message lands. We just skip them this
// tick (leave 'pending'); a later */5 tick re-picks them once 15 min elapse.
// 15 min ≪ the 24h stale cutoff, so a delayed row is never staled out first.
const BAD_NEWS = new Set(['lost', 'returned', 'disputed'])
const BAD_NEWS_DELAY_MS = 15 * 60 * 1000

// In-flight guard so the */5 cron can't re-enter while a slow tick is still
// draining (two overlapping ticks would send the same rows twice — Codex #3).
let notifierRunning = false

// Drains pending shipping notifications and delivers each via the existing
// platform-message channel (WeChat customer-service message / iMessage), the
// same path reminder-sender uses. Single-attempt: success → 'sent', delivery
// error → 'failed' (terminal). No-copy / no-platform / opted-out → 'skipped'.
export async function sendPendingShippingNotifications() {
  if (notifierRunning) {
    log('warn', 'shipping_notifier_overlap_skipped', {})
    return
  }
  notifierRunning = true
  try {
  // Triage first: pending rows scheduled >24h ago are stale (backlog built up
  // while the notifier was disabled or down) — mark them 'skipped' instead of
  // blasting outdated status updates at students, and log how many.
  const staleCount = await markStaleNotificationsSkipped()
  if (staleCount > 0) {
    log('warn', 'shipping_notifications_stale_skipped', { count: staleCount })
    // A large stale drop means we fell >24h behind — almost always a george
    // host outage. Surface it loudly. NOTE: a full host-down state itself can't
    // be detected here (this cron doesn't run when george is down); pair this
    // with EXTERNAL uptime monitoring on the host.
    if (staleCount >= config.shippingNotifier.queueAlertDepth) {
      log('error', 'shipping_queue_alert', {
        reason: 'stale_backlog_dropped',
        count: staleCount,
        hint: 'notifier was >24h behind — check the george host + add external uptime monitoring',
      })
    }
  }

  const pending = await getPendingShippingNotifications()
  if (pending.length >= QUEUE_TICK_LIMIT) {
    log('error', 'shipping_queue_alert', {
      reason: 'backlog_at_tick_limit',
      depth: pending.length,
      hint: 'pending exceeds one tick — drain is falling behind, rows risk aging into the stale window',
    })
  }
  if (pending.length === 0) return

  for (const n of pending) {
    const id = n.id as string
    const kind = n.kind as string
    // student_id → students is a to-one FK (object at runtime); the generated
    // types don't yet know the new table's relation, so cast through unknown.
    const student = n.students as unknown as Record<string, unknown> | null

    // Bad-news head start: hold ~15 min, retry on a later tick.
    if (BAD_NEWS.has(kind)) {
      const createdMs = new Date(n.created_at as string).getTime()
      if (Number.isFinite(createdMs) && Date.now() - createdMs < BAD_NEWS_DELAY_MS) {
        continue
      }
    }

    const text = messageForKind(kind, n.payload as Record<string, unknown> | null)
    if (!text) {
      await markShippingNotificationSkipped(id, 'no_copy_for_kind')
      continue
    }
    // Pickup messages need member_id + location, else they render with blanks —
    // skip rather than send a confusing message (Codex #10).
    if (kind === 'pickup_open' || kind === 'pickup_reminder') {
      const payload = (n.payload ?? {}) as Record<string, unknown>
      if (!payload.member_id || !payload.pickup_location) {
        await markShippingNotificationSkipped(id, 'incomplete_pickup_payload')
        continue
      }
    }
    if (!student) {
      await markShippingNotificationSkipped(id, 'no_student')
      continue
    }
    if (student.shipping_notif_opt_out) {
      await markShippingNotificationSkipped(id, 'opted_out')
      continue
    }
    // Dry-run allowlist (Phase-1 go-live): when SHIPPING_NOTIFIER_ALLOWLIST is
    // set, only deliver to students whose wechat_open_id / imessage_id is listed;
    // everyone else is skipped. Empty allowlist = no filtering (full operation).
    const allowlist = config.shippingNotifier.allowlist
    if (allowlist.length > 0) {
      const handleIds = [student.wechat_open_id, student.imessage_id].filter(
        Boolean,
      ) as string[]
      if (!handleIds.some((h) => allowlist.includes(h))) {
        await markShippingNotificationSkipped(id, 'not_in_allowlist')
        continue
      }
    }
    // Delivery targets, primary first: WeChat if linked, else iMessage. If the
    // primary throws (e.g. WeChat 48h-window errcode after the errcode fix, or
    // the Mac's iMessage SDK is disconnected), fall back to the other channel so
    // a dual-linked student still gets the update. Stop at the first success —
    // no double-send.
    const wechatId = (student.wechat_open_id ?? null) as string | null
    const imessageId = (student.imessage_id ?? null) as string | null
    const targets: Array<{ platform: 'wechat' | 'imessage'; id: string }> = []
    if (wechatId) targets.push({ platform: 'wechat', id: wechatId })
    if (imessageId) targets.push({ platform: 'imessage', id: imessageId })
    if (targets.length === 0) {
      await markShippingNotificationSkipped(id, 'no_platform_id')
      continue
    }

    let delivered = false
    let lastErr = ''
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      try {
        await sendPlatformMessage(t.platform, t.id, text)
        await markShippingNotificationSent(id)
        log('info', 'shipping_notification_sent', {
          id,
          kind,
          platform: t.platform,
          fellBack: i > 0,
        })
        delivered = true
        break
      } catch (err) {
        lastErr = (err as Error).message
        log('warn', 'shipping_notification_send_failed', {
          id,
          platform: t.platform,
          error: lastErr,
        })
      }
    }
    if (!delivered) {
      await markShippingNotificationFailed(id, lastErr)
      log('error', 'shipping_notification_error', { id, error: lastErr })
    }
  }
  } finally {
    notifierRunning = false
  }
}
