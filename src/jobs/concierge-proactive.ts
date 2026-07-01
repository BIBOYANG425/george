// src/jobs/concierge-proactive.ts
// T7 proactive surfacer — SQUAD branch. Gated by CONCIERGE_PROACTIVE_ENABLED (default OFF).
//
// For each OPTED-IN student, find their top open squad post (hybrid_search_posts_for_user, the
// inverse of the reactive match_users_for_post) and, if it clears a fit floor and isn't their own
// post, propose it → the SAME officer glance (proposed_matches → approve → intro). Nothing is ever
// delivered to a student here; only a proposal is queued for the officer.
//
// The EVENT branch of T7 is the EXISTING matchStudentsToEvents cron (src/jobs/proactive.ts, gated by
// PROACTIVE_ENABLED): it sends an interest-filtered approved event directly and writes ZERO
// proposed_matches — exactly the two-lane split (event = governed upstream, squad = officer glance).

import { supabase } from '../db/client.js'
import { config } from '../config.js'
import { log } from '../observability/logger.js'
import { proposeStudentForPost } from '../services/match-proposal-deps.js'

const MIN_FIT_SCORE = 0.02 // hybrid RRF floor; below this a match isn't worth an officer glance
const MAX_STUDENTS_PER_RUN = 20 // cap how many proposals a single run can add to the officer's queue
const QUIET_START_LA = 22
const QUIET_END_LA = 8

export interface RankedPost {
  id: string
  created_by_student_id?: string | null
  rrf_score?: number
  score?: number
  category?: string | null
  matched_tags?: string[] | null
  best_facet?: string | null
}

/**
 * Pure: choose the best open post to propose for a student, or null. Excludes the student's own
 * posts and anything below the fit floor. Exported for tests.
 */
export function selectSquadProposal(
  posts: RankedPost[],
  studentId: string,
  minScore = MIN_FIT_SCORE,
): { postId: string; fitScore: number; reason: string | null } | null {
  const scored = posts
    .filter((p) => p && p.id && p.created_by_student_id !== studentId)
    .map((p) => ({ p, s: p.rrf_score ?? p.score ?? 0 }))
    .sort((a, b) => b.s - a.s)
  const top = scored[0]
  if (!top || top.s < minScore) return null
  const reason = top.p.matched_tags?.[0] ?? top.p.best_facet ?? null
  return { postId: top.p.id, fitScore: top.s, reason }
}

function inQuietHoursLA(): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  const h = parseInt(fmt.format(new Date()), 10)
  return h >= QUIET_START_LA || h < QUIET_END_LA
}

/**
 * One proactive-surfacing pass. No-op unless CONCIERGE_PROACTIVE_ENABLED. Consent-first: only
 * pings-enabled students are even considered (the officer glance is a second gate downstream).
 */
export async function surfaceSquadForStudents(): Promise<{ proposed: number; scanned: number }> {
  if (!config.concierge.proactiveEnabled) return { proposed: 0, scanned: 0 }
  if (inQuietHoursLA()) {
    log('info', 'concierge_proactive_quiet_hours', {})
    return { proposed: 0, scanned: 0 }
  }

  const { data: prefs, error } = await supabase
    .from('user_match_prefs')
    .select('student_id')
    .eq('pings_enabled', true)
    .limit(MAX_STUDENTS_PER_RUN)
  if (error || !prefs || prefs.length === 0) return { proposed: 0, scanned: 0 }

  let proposed = 0
  for (const row of prefs as { student_id: string }[]) {
    const studentId = row.student_id
    try {
      const { data, error: rpcErr } = await supabase.rpc('hybrid_search_posts_for_user', {
        p_student_id: studentId,
        p_match_count: 10,
      })
      if (rpcErr || !data) continue
      const pick = selectSquadProposal(data as RankedPost[], studentId)
      if (!pick) continue
      const r = await proposeStudentForPost(studentId, pick.postId, pick.fitScore, pick.reason)
      if (r === 'proposed') proposed++
    } catch (e) {
      log('error', 'concierge_proactive_student_error', { studentId, err: (e as Error).message })
    }
  }
  log('info', 'concierge_proactive_run', { proposed, scanned: prefs.length })
  return { proposed, scanned: prefs.length }
}
