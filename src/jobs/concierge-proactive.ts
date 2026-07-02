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
import {
  proposeStudentForPost,
  isStudentEligibleForPost,
  notifyOfficerDigest,
  type ProactiveProposal,
} from '../services/match-proposal-deps.js'

const MIN_FIT_SCORE = 0.02 // hybrid RRF floor; below this a match isn't worth an officer glance
const MAX_STUDENTS_PER_RUN = 20 // how many opted-in students a single run ATTEMPTS (after shuffle)
const MAX_OPTED_IN_SCAN = 500 // pool fetched before shuffling — bounds the query, not the attempts
const QUIET_START_LA = 22
const QUIET_END_LA = 8

// Shape of a hybrid_search_posts_for_user row (verified against the live RPC: post_id, rrf_score,
// matched_tags, best_facet — NOT `id`, and NO creator column, so own/joined exclusion is a DB step).
export interface RankedPost {
  post_id: string
  rrf_score?: number
  matched_tags?: string[] | null
  best_facet?: string | null
}

/**
 * Pure: rank the candidate posts above the fit floor, highest first. Own/joined exclusion is NOT here
 * (the RPC row carries no creator/membership) — the caller applies isStudentEligibleForPost and falls
 * through to the next candidate, since a student's OWN post often ranks #1. Exported for tests.
 */
export function selectSquadCandidates(
  posts: RankedPost[],
  minScore = MIN_FIT_SCORE,
): Array<{ postId: string; fitScore: number; reason: string | null }> {
  return posts
    .filter((p) => p && p.post_id)
    .map((p) => ({ p, s: p.rrf_score ?? 0 }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .map((x) => ({ postId: x.p.post_id, fitScore: x.s, reason: x.p.matched_tags?.[0] ?? x.p.best_facet ?? null }))
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

  // Fetch opted-in students (bounded) and SHUFFLE so a fixed leading window is never starved when
  // there are more than MAX_STUDENTS_PER_RUN of them — each run samples a random subset.
  const { data: prefs, error } = await supabase
    .from('user_match_prefs')
    .select('student_id')
    .eq('pings_enabled', true)
    .limit(MAX_OPTED_IN_SCAN)
  if (error || !prefs || prefs.length === 0) return { proposed: 0, scanned: 0 }
  const ids = (prefs as { student_id: string }[]).map((r) => r.student_id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  const batch = ids.slice(0, MAX_STUDENTS_PER_RUN)

  const collected: ProactiveProposal[] = []
  for (const studentId of batch) {
    try {
      const { data, error: rpcErr } = await supabase.rpc('hybrid_search_posts_for_user', {
        p_student_id: studentId,
        p_match_count: 10,
      })
      if (rpcErr || !data) continue
      // Walk candidates best-first; skip own/already-joined posts and fall through to the next.
      for (const cand of selectSquadCandidates(data as RankedPost[])) {
        if (!(await isStudentEligibleForPost(studentId, cand.postId))) continue
        const proposal = await proposeStudentForPost(studentId, cand.postId, cand.fitScore, cand.reason)
        if (proposal) { collected.push(proposal); break } // proposed; null = already-live, try next
      }
    } catch (e) {
      log('error', 'concierge_proactive_student_error', { studentId, err: (e as Error).message })
    }
  }
  if (collected.length > 0) await notifyOfficerDigest(collected) // ONE officer message per run, not N
  log('info', 'concierge_proactive_run', { proposed: collected.length, scanned: batch.length })
  return { proposed: collected.length, scanned: batch.length }
}
