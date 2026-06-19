// src/services/reach-eval-deps.ts
//
// Real-service wiring for the re-reach evaluator (mirrors squad-coordinator-deps.ts).
// A NEW candidate query over Supabase, the reused proactive send seam
// (getActiveSpectrumClient), a fresh handleFor, and a NEW dedup stamp that does
// NOT touch the coordinator's idempotency columns (brokered_at /
// reminder_sent_at / completed_at / needs_refill).
//
// SCHEMA NOTE (cross-repo): markReached / alreadyReached read+write a NEW
// optional column `rereached_at` on squad_pings, owned by a bia-admin migration.
// George only reads/writes existing tables, so the column ships in bia-admin
// FIRST. Until then SQUAD_REREACH_EVAL_ENABLED stays OFF — the cron block in
// index.ts is never registered, so buildReachEvalDeps() is never called and no
// query touches the missing column.
//
// Candidacy: a stalled web-interest ping (response='joined') that was never
// brokered AND never re-reached, on a still-open post. The pure staleness check
// (older than SQUAD_REREACH_STALE_HOURS) lives in reach.ts (shouldReachCandidate),
// keyed off the post's last activity; the query supplies created_at as the
// last-activity timestamp. The default threshold (48h) sits well past the
// coordinator's 24h reminder window, so a re-reach never races a live reminder.

import { supabase } from '../db/client.js'
import type { ReachEvalDeps, ReachCandidate } from '../agent/evaluators/reach.js'
import { reachStaleHours } from '../agent/evaluators/reach.js'

export function buildReachEvalDeps(): ReachEvalDeps {
  return {
    // Stalled candidates: joined-but-not-brokered, not-yet-re-reached pings on
    // open posts. Distinct from the coordinator's selectWebInterest (which keys
    // off brokered_at IS NULL alone and brokers immediately). Here we additionally
    // require rereached_at IS NULL so the dedup stamp prevents repeat nudges.
    selectReachCandidates: async (): Promise<ReachCandidate[]> => {
      const { data: pings, error: pErr } = await supabase
        .from('squad_pings')
        .select('id, recipient_student_id, post_id, created_at')
        .eq('response', 'joined')
        .is('brokered_at', null)
        .is('rereached_at', null)
      if (pErr || !pings || pings.length === 0) return []
      const candidates = pings as Array<{
        id: string; recipient_student_id: string; post_id: string; created_at: string
      }>
      const postIds = [...new Set(candidates.map((c) => c.post_id))]
      const nowMs = Date.now()
      const { data: posts, error: poErr } = await supabase
        .from('squad_posts')
        .select('id, poster_name, category, location, current_people, max_people, deadline, completed_at, cancelled_at')
        .in('id', postIds)
      if (poErr || !posts) return []
      const openPost = new Map<string, { posterName: string; category: string; location: string | null }>()
      for (const p of posts as Array<{
        id: string; poster_name: string | null; category: string | null; location: string | null
        current_people: number; max_people: number; deadline: string | null
        completed_at: string | null; cancelled_at: string | null
      }>) {
        const isOpen = !p.cancelled_at && !p.completed_at && p.current_people < p.max_people &&
          (!p.deadline || new Date(p.deadline).getTime() > nowMs)
        if (isOpen) openPost.set(p.id, { posterName: p.poster_name ?? '学长', category: p.category ?? '活动', location: p.location })
      }
      if (openPost.size === 0) return []
      const rows: ReachCandidate[] = []
      for (const c of candidates) {
        const post = openPost.get(c.post_id)
        if (!post) continue
        rows.push({
          postId: c.post_id,
          studentId: c.recipient_student_id,
          posterName: post.posterName,
          category: post.category,
          location: post.location,
          lastActivityAt: c.created_at,
        })
      }
      return rows
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

    // NEW dedup stamp on squad_pings.rereached_at — NOT a coordinator column.
    markReached: async (postId: string, studentId: string): Promise<void> => {
      await supabase
        .from('squad_pings')
        .update({ rereached_at: new Date().toISOString() })
        .eq('post_id', postId)
        .eq('recipient_student_id', studentId)
    },
    alreadyReached: async (postId: string, studentId: string): Promise<boolean> => {
      const { data, error } = await supabase
        .from('squad_pings')
        .select('rereached_at')
        .eq('post_id', postId)
        .eq('recipient_student_id', studentId)
        .not('rereached_at', 'is', null)
        .limit(1)
      if (error || !data) return false
      return (data as Array<{ rereached_at: string | null }>).length > 0
    },

    staleHours: reachStaleHours,
  }
}
