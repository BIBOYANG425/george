// src/services/squad-coordinator-deps.ts
// Real-service wiring for the Squad Coordinator engine. The four select queries
// over Supabase + the reused Phase 2 proactive seam (getActiveSpectrumClient)
// and ping fanout (triggerPingFanout). Service-role client (server-side cron);
// the matching tables stay deny-all RLS.
import { supabase } from '../db/client.js'
import { triggerPingFanout } from './squad-ping-deps.js'
import type { CoordinatorDeps, WebInterestRow, ReminderRow } from '../jobs/squad-coordinator.js'

function nowHourLA(): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  return parseInt(fmt.format(new Date()), 10)
}

const num = (v: string | undefined, d: number) => {
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : d
}

export function buildCoordinatorDeps(): CoordinatorDeps {
  const reminderWindowH = num(process.env.SQUAD_REMINDER_WINDOW_HOURS, 24)
  const completionGraceH = num(process.env.SQUAD_COMPLETION_GRACE_HOURS, 12)
  const deepQuiet = {
    start: num(process.env.SQUAD_DEEP_QUIET_START_HOUR_LA, 2),
    end: num(process.env.SQUAD_DEEP_QUIET_END_HOUR_LA, 8),
  }

  return {
    // web-expressed interest: response='joined' pings with no member row + not yet brokered + post still open.
    selectWebInterest: async (): Promise<WebInterestRow[]> => {
      const { data: pings, error: pErr } = await supabase
        .from('squad_pings')
        .select('id, recipient_student_id, post_id')
        .eq('response', 'joined')
        .is('brokered_at', null)
      if (pErr || !pings || pings.length === 0) return []
      const candidates = pings as Array<{ id: string; recipient_student_id: string; post_id: string }>
      const postIds = [...new Set(candidates.map((c) => c.post_id))]
      // Query the base table and derive 'open' inline (the view's status formula): not cancelled,
      // not completed, room left, and deadline null-or-future. completed_at/needs_refill don't exist
      // on the squad_posts_with_status view, so the post-status lookup runs against squad_posts.
      const nowMs = Date.now()
      const { data: posts, error: poErr } = await supabase
        .from('squad_posts')
        .select('id, category, location, current_people, max_people, deadline, completed_at, cancelled_at')
        .in('id', postIds)
      if (poErr || !posts) return []
      const openPost = new Map<string, { category: string | null; location: string | null }>()
      for (const p of posts as Array<{
        id: string; category: string | null; location: string | null
        current_people: number; max_people: number; deadline: string | null
        completed_at: string | null; cancelled_at: string | null
      }>) {
        const isOpen = !p.cancelled_at && !p.completed_at && p.current_people < p.max_people &&
          (!p.deadline || new Date(p.deadline).getTime() > nowMs)
        if (isOpen) openPost.set(p.id, { category: p.category, location: p.location })
      }
      if (openPost.size === 0) return []
      const { data: members } = await supabase
        .from('squad_members')
        .select('post_id, student_id')
        .in('post_id', [...openPost.keys()])
      const memberSet = new Set(
        (members ?? []).map((m: { post_id: string; student_id: string | null }) => `${m.post_id}|${m.student_id}`),
      )
      const rows: WebInterestRow[] = []
      for (const c of candidates) {
        const post = openPost.get(c.post_id)
        if (!post) continue
        if (memberSet.has(`${c.post_id}|${c.recipient_student_id}`)) continue
        rows.push({ ping_id: c.id, recipient_student_id: c.recipient_student_id, category: post.category ?? '活动', location: post.location })
      }
      return rows
    },

    // RSVP reminder: open/full posts with a deadline in the window, not yet reminded, with >=1 member.
    selectReminders: async (): Promise<ReminderRow[]> => {
      const nowMs = Date.now()
      const nowIso = new Date(nowMs).toISOString()
      const windowEnd = new Date(nowMs + reminderWindowH * 3600_000).toISOString()
      // Query the base table: reminder_sent_at/completed_at/cancelled_at live there, not on the
      // squad_posts_with_status view (which only projects display columns + a computed status).
      // deadline in (now, windowEnd] => never 'expired'; with cancelled_at null the status the view
      // would report is 'full' (current>=max) or 'open' — both qualify, so we don't need the view.
      const { data: posts, error } = await supabase
        .from('squad_posts')
        .select('id, poster_name, category, location, deadline')
        .is('reminder_sent_at', null)
        .is('completed_at', null)
        .is('cancelled_at', null)
        .not('deadline', 'is', null)
        .gt('deadline', nowIso)
        .lte('deadline', windowEnd)
      if (error || !posts) return []
      const open = posts as Array<{ id: string; poster_name: string | null; category: string | null; location: string | null }>
      if (open.length === 0) return []
      const { data: members } = await supabase
        .from('squad_members')
        .select('post_id, student_id')
        .in('post_id', open.map((p) => p.id))
      const byPost = new Map<string, string[]>()
      for (const m of (members ?? []) as Array<{ post_id: string; student_id: string | null }>) {
        if (!m.student_id) continue
        const arr = byPost.get(m.post_id) ?? []
        arr.push(m.student_id)
        byPost.set(m.post_id, arr)
      }
      const rows: ReminderRow[] = []
      for (const p of open) {
        const ids = byPost.get(p.id) ?? []
        if (ids.length === 0) continue
        rows.push({ post_id: p.id, poster_name: p.poster_name ?? '学长', category: p.category ?? '活动', location: p.location, member_student_ids: ids })
      }
      return rows
    },

    // refill: open posts flagged needs_refill with room and a future (or no) deadline.
    // needs_refill/completed_at live on the base table, not the squad_posts_with_status view; the
    // 'open' status is derived inline (not cancelled + room left + deadline null-or-future).
    selectRefills: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('squad_posts')
        .select('id, current_people, max_people, deadline, needs_refill, completed_at, cancelled_at')
        .eq('needs_refill', true)
        .is('completed_at', null)
        .is('cancelled_at', null)
      if (error || !data) return []
      const now = Date.now()
      return (data as unknown as Array<{
        id: string; current_people: number; max_people: number; deadline: string | null
      }>)
        .filter((p) => p.current_people < p.max_people && (!p.deadline || new Date(p.deadline).getTime() > now))
        .map((p) => p.id)
    },

    // completion: past deadline + grace, not completed/cancelled.
    selectCompletions: async (): Promise<string[]> => {
      const cutoff = new Date(Date.now() - completionGraceH * 3600_000).toISOString()
      const { data, error } = await supabase
        .from('squad_posts')
        .select('id, deadline, completed_at, cancelled_at')
        .is('completed_at', null)
        .is('cancelled_at', null)
        .not('deadline', 'is', null)
        .lt('deadline', cutoff)
      if (error || !data) return []
      return (data as Array<{ id: string }>).map((p) => p.id)
    },

    handleFor: async (studentId: string): Promise<string | null> => {
      const { data, error } = await supabase.from('students').select('imessage_id').eq('id', studentId).single()
      if (error || !data) return null
      return (data as { imessage_id: string | null }).imessage_id ?? null
    },

    sendProactive: async (handle: string, bubbles: string[]): Promise<void> => {
      const { getActiveSpectrumClient } = await import('../adapters/spectrum.js')
      const c = getActiveSpectrumClient()
      if (!c) throw new Error('no_spectrum_connection')
      await c.sendProactive(handle, bubbles)
    },

    runFanout: async (postId: string): Promise<void> => { await triggerPingFanout(postId) },

    markBrokered: async (pingId: string): Promise<void> => {
      await supabase.from('squad_pings').update({ brokered_at: new Date().toISOString() }).eq('id', pingId)
    },
    markReminderSent: async (postId: string): Promise<void> => {
      await supabase.from('squad_posts').update({ reminder_sent_at: new Date().toISOString() }).eq('id', postId)
    },
    clearNeedsRefill: async (postId: string): Promise<void> => {
      await supabase.from('squad_posts').update({ needs_refill: false }).eq('id', postId)
    },
    markCompleted: async (postId: string): Promise<void> => {
      await supabase.from('squad_posts').update({ completed_at: new Date().toISOString() }).eq('id', postId)
    },

    nowHourLA,
    deepQuiet,
  }
}
