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
      const { data, error } = await supabase
        .from('squad_pings')
        .select('id, recipient_student_id, squad_posts_with_status!inner(category, location, status), ' +
                'squad_members!left(student_id)')
        .eq('response', 'joined')
        .is('brokered_at', null)
      if (error || !data) return []
      const rows: WebInterestRow[] = []
      for (const r of data as unknown as Array<{
        id: string; recipient_student_id: string
        squad_posts_with_status: { category: string | null; location: string | null; status: string } | null
        squad_members: Array<{ student_id: string | null }>
      }>) {
        const post = r.squad_posts_with_status
        if (!post || post.status !== 'open') continue
        if ((r.squad_members ?? []).some((m) => m.student_id === r.recipient_student_id)) continue
        rows.push({ ping_id: r.id, recipient_student_id: r.recipient_student_id, category: post.category ?? '活动', location: post.location })
      }
      return rows
    },

    // RSVP reminder: open/full posts with a deadline in the window, not yet reminded, with >=1 member.
    selectReminders: async (): Promise<ReminderRow[]> => {
      const nowMs = Date.now()
      const windowStart = new Date(nowMs).toISOString()
      const windowEnd = new Date(nowMs + reminderWindowH * 3600_000).toISOString()
      const { data, error } = await supabase
        .from('squad_posts_with_status')
        .select('id, poster_name, category, location, status, deadline, reminder_sent_at, ' +
                'squad_members(student_id)')
        .is('reminder_sent_at', null)
        .not('deadline', 'is', null)
        .gt('deadline', windowStart)
        .lte('deadline', windowEnd)
      if (error || !data) return []
      const rows: ReminderRow[] = []
      for (const p of data as unknown as Array<{
        id: string; poster_name: string | null; category: string | null; location: string | null; status: string
        squad_members: Array<{ student_id: string | null }>
      }>) {
        if (p.status !== 'open' && p.status !== 'full') continue
        const members = (p.squad_members ?? []).map((m) => m.student_id).filter((s): s is string => !!s)
        if (members.length === 0) continue
        rows.push({ post_id: p.id, poster_name: p.poster_name ?? '学长', category: p.category ?? '活动', location: p.location, member_student_ids: members })
      }
      return rows
    },

    // refill: open posts flagged needs_refill with room and a future (or no) deadline.
    selectRefills: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('squad_posts_with_status')
        .select('id, status, current_people, max_people, deadline, needs_refill, completed_at, cancelled_at')
        .eq('needs_refill', true)
        .is('completed_at', null)
        .is('cancelled_at', null)
      if (error || !data) return []
      const now = Date.now()
      return (data as unknown as Array<{
        id: string; status: string; current_people: number; max_people: number; deadline: string | null
      }>)
        .filter((p) => p.status === 'open' && p.current_people < p.max_people && (!p.deadline || new Date(p.deadline).getTime() > now))
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
