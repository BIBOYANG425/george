// src/services/squad-ping-deps.ts
// Real-service wiring for the squad-ping fan-out engine. Thin glue between
// squad-ping-engine (pure, fully tested) and Supabase + Spectrum delivery.
// NOT unit-tested here — the engine's invariants are covered by the engine
// tests; this file's correctness is verified by integration / E2E.

import { supabase } from '../db/client.js'
import { getActiveSpectrumClient } from '../adapters/spectrum.js'
import { runPingFanout } from './squad-ping-engine.js'
import type { MatchCandidate, MatchPrefs, PingRow, PingDeps } from './squad-ping-engine.js'

// nowHourLA: current hour in America/Los_Angeles.
function nowHourLA(): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false,
  })
  return parseInt(fmt.format(new Date()), 10)
}

interface PostData {
  category: string | null
  content: string | null
  location: string | null
  max_people: number | null
  current_people: number | null
}

// Build a PingDeps bound to a specific postId.
// `postData` is loaded once and closed over to avoid repeated DB reads.
async function loadPostData(postId: string): Promise<PostData | null> {
  const { data, error } = await supabase
    .from('squad_posts')
    .select('category, content, location, max_people, current_people')
    .eq('id', postId)
    .single()
  if (error || !data) return null
  return data as PostData
}

export async function buildPingDeps(postId: string): Promise<PingDeps> {
  const post = await loadPostData(postId)

  const composePing = (candidate: MatchCandidate, _postId: string): string[] => {
    const cat = post?.category ?? '活动'
    const loc = post?.location ? ` ${post.location}` : ''
    const current = post?.current_people ?? 1
    const max = post?.max_people ?? 2
    const need = max - current
    const bubble1 = `诶 有人组了${cat}局${loc} ${current}缺${need}`
    const reason = candidate.matched_tags[0] ?? candidate.best_facet ?? '类似的'
    const bubble2 = `你之前提到${reason} 想去我帮你报名 不想去忽略我就行哈哈哈`
    return [bubble1, bubble2]
  }

  return {
    matchUsers: async (pid: string): Promise<MatchCandidate[]> => {
      const { data, error } = await supabase.rpc('match_users_for_post', {
        p_post_id: pid,
      })
      if (error || !data) return []
      return (data as MatchCandidate[])
    },

    loadPrefs: async (studentId: string): Promise<MatchPrefs | null> => {
      const { data, error } = await supabase
        .from('user_match_prefs')
        .select('student_id, pings_enabled, weekly_ping_cap, quiet_start_hour, quiet_end_hour, allowed_categories, channel')
        .eq('student_id', studentId)
        .single()
      if (error || !data) return null
      return data as MatchPrefs
    },

    countSentThisWeek: async (studentId: string): Promise<number> => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { count, error } = await supabase
        .from('squad_pings')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_student_id', studentId)
        .eq('status', 'sent')
        .gte('sent_at', since)
      if (error) return 0
      return count ?? 0
    },

    handleFor: async (studentId: string): Promise<string | null> => {
      const { data, error } = await supabase
        .from('students')
        .select('imessage_id')
        .eq('id', studentId)
        .single()
      if (error || !data) return null
      return (data as { imessage_id: string | null }).imessage_id ?? null
    },

    recordPing: async (row: PingRow): Promise<void> => {
      await supabase.from('squad_pings').insert({
        post_id: row.post_id,
        recipient_student_id: row.recipient_student_id,
        score: row.score,
        channel: row.channel,
        status: row.status,
        sent_at: row.sent_at,
      })
    },

    deliver: async (handle: string, bubbles: string[]): Promise<void> => {
      const c = getActiveSpectrumClient()
      if (!c) throw new Error('no_spectrum_connection')
      await c.sendProactive(handle, bubbles)
    },

    composePing,

    nowHourLA,

    maxPings: 5,

    postCategory: post?.category ?? undefined,
  }
}

// Convenience: load deps and run the full fan-out for a given postId.
export async function triggerPingFanout(postId: string): Promise<{ sent: number; suppressed: number }> {
  const deps = await buildPingDeps(postId)
  return runPingFanout(postId, deps)
}
