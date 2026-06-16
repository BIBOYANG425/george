// src/jobs/squad-coordinator.ts
// Pure after-join coordination engine (spec 2026-06-15-squad-phase4). Four
// behaviors over injected deps: broker web-expressed interest, RSVP reminder,
// refill a dropped spot (reuses the Phase 2 ping fanout), auto-complete.
// Template messages only — NO LLM on this path. Idempotent: one-shot stamps
// (brokered_at/reminder_sent_at/completed_at) + the re-settable needs_refill.
// At-least-once: stamp ONLY after a successful send (a failed send retries next
// tick). Gating is split — broker/reminder bypass cap+pings_enabled (joining =
// consent) and apply only a deep-quiet floor here; refill goes through runFanout,
// which applies ALL cold-ping gates.

export interface WebInterestRow {
  ping_id: string
  recipient_student_id: string
  category: string
  location: string | null
}
export interface ReminderRow {
  post_id: string
  poster_name: string
  category: string
  location: string | null
  member_student_ids: string[]
}

export interface CoordinatorDeps {
  selectWebInterest: () => Promise<WebInterestRow[]>
  selectReminders: () => Promise<ReminderRow[]>
  selectRefills: () => Promise<string[]>
  selectCompletions: () => Promise<string[]>
  handleFor: (studentId: string) => Promise<string | null>
  sendProactive: (handle: string, bubbles: string[]) => Promise<void>
  runFanout: (postId: string) => Promise<void>
  markBrokered: (pingId: string) => Promise<void>
  markReminderSent: (postId: string) => Promise<void>
  clearNeedsRefill: (postId: string) => Promise<void>
  markCompleted: (postId: string) => Promise<void>
  nowHourLA: () => number
  deepQuiet: { start: number; end: number }
}

export function inDeepQuiet(hour: number, q: { start: number; end: number }): boolean {
  return q.start <= q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end
}

const loc = (l: string | null) => (l ? ` ${l}` : '')

export function brokerBubble(category: string, location: string | null): string {
  return `诶 看到你想加入${category}局${loc(location)} 想去的话回我一声 我帮你报名哈`
}
export function reminderBubble(posterName: string, category: string, location: string | null): string {
  return `${posterName} 的${category}局${loc(location)} 还来吗? 回 来/不来 哈`
}

async function brokerWebInterest(deps: CoordinatorDeps): Promise<void> {
  if (inDeepQuiet(deps.nowHourLA(), deps.deepQuiet)) return
  for (const r of await deps.selectWebInterest()) {
    const handle = await deps.handleFor(r.recipient_student_id)
    if (!handle) continue
    try {
      await deps.sendProactive(handle, [brokerBubble(r.category, r.location)])
      await deps.markBrokered(r.ping_id)
    } catch {
      // no connection / send failed — leave brokered_at null, retried next tick
    }
  }
}

async function sendReminders(deps: CoordinatorDeps): Promise<void> {
  if (inDeepQuiet(deps.nowHourLA(), deps.deepQuiet)) return
  for (const p of await deps.selectReminders()) {
    let anySent = false
    for (const sid of p.member_student_ids) {
      const handle = await deps.handleFor(sid)
      if (!handle) continue
      try {
        await deps.sendProactive(handle, [reminderBubble(p.poster_name, p.category, p.location)])
        anySent = true
      } catch {
        // skip this member, retried next tick (post stays un-stamped if nobody was reached)
      }
    }
    if (anySent) await deps.markReminderSent(p.post_id)
  }
}

async function refillDropouts(deps: CoordinatorDeps): Promise<void> {
  for (const postId of await deps.selectRefills()) {
    try {
      await deps.runFanout(postId)
      await deps.clearNeedsRefill(postId)
    } catch {
      // leave needs_refill true, retried next tick
    }
  }
}

async function completeExpired(deps: CoordinatorDeps): Promise<void> {
  for (const postId of await deps.selectCompletions()) {
    await deps.markCompleted(postId)
  }
}

export async function runCoordinatorOnce(deps: CoordinatorDeps): Promise<void> {
  await brokerWebInterest(deps)
  await sendReminders(deps)
  await refillDropouts(deps)
  await completeExpired(deps)
}
