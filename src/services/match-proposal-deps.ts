// src/services/match-proposal-deps.ts
// Real-service wiring for the concierge match-proposal engine (Supabase + Spectrum). Mirrors
// squad-ping-deps.ts. NOT unit-tested here — the pure engine's invariants are covered by
// match-proposal-engine.test.ts; this file's correctness is integration/E2E.
//
// TODO(dry): matchUsers / loadPrefs / countSentThisWeek / handleFor / recordPing / deliver / nowHourLA
// are duplicated from squad-ping-deps.ts ON PURPOSE. Extracting a shared module now would refactor the
// LIVE, unit-test-uncovered auto-ping path for a default-OFF feature (production risk for marginal gain).
// Extract into a shared module once the concierge lane is E2E-verified.

import { randomUUID } from 'node:crypto'
import { supabase } from '../db/client.js'
import { config } from '../config.js'
import { normalizeHandle } from './phone-handle.js'
import { logFunnelEvent } from './funnel-log.js'
import { proposeMatches } from './match-proposal-engine.js'
import type { MatchCandidate, MatchPrefs, PingRow } from './squad-ping-engine.js'
import type { Proposal, ProposalDeps, ProposalSummary } from './match-proposal-engine.js'

// Concierge queues fewer than the auto fan-out cap (MAX_PINGS_PER_POST=5): a human glances at each,
// so bias to the top few highest-fit candidates.
const MAX_PROPOSALS_PER_POST = 3

function nowHourLA(): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  return parseInt(fmt.format(new Date()), 10)
}

export interface PostCopy {
  category: string | null
  location: string | null
  current_people: number | null
  max_people: number | null
}

async function loadPostCopy(postId: string): Promise<PostCopy | null> {
  const { data, error } = await supabase
    .from('squad_posts')
    .select('category, location, current_people, max_people')
    .eq('id', postId)
    .single()
  if (error || !data) return null
  return data as PostCopy
}

// ─── lifted from squad-ping-deps (see TODO(dry) above) ───────────────────────
async function matchUsers(postId: string): Promise<MatchCandidate[]> {
  const { data, error } = await supabase.rpc('match_users_for_post', { p_post_id: postId })
  if (error) throw new Error(`match_users_for_post failed: ${error.message}`)
  const rows = (data ?? []) as unknown[]
  if (rows.length > 0) {
    const first = rows[0] as Record<string, unknown>
    if (typeof first.rrf_score !== 'number' || typeof first.student_id !== 'string') {
      throw new Error('match_users_for_post returned unexpected row shape')
    }
  }
  return rows as MatchCandidate[]
}

async function loadPrefs(studentId: string): Promise<MatchPrefs | null> {
  const { data, error } = await supabase
    .from('user_match_prefs')
    .select('student_id, pings_enabled, weekly_ping_cap, quiet_start_hour, quiet_end_hour, allowed_categories, channel')
    .eq('student_id', studentId)
    .single()
  if (error || !data) return null
  return data as MatchPrefs
}

async function countSentThisWeek(studentId: string): Promise<number> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await supabase
    .from('squad_pings')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_student_id', studentId)
    .eq('status', 'sent')
    .gte('sent_at', since)
  if (error) return Number.MAX_SAFE_INTEGER // fail closed: never look under-cap on error
  return count ?? 0
}

async function handleFor(studentId: string): Promise<string | null> {
  const { data, error } = await supabase.from('students').select('imessage_id').eq('id', studentId).single()
  if (error || !data) return null
  return (data as { imessage_id: string | null }).imessage_id ?? null
}

async function recordPing(row: PingRow): Promise<void> {
  const { error } = await supabase.from('squad_pings').insert({
    post_id: row.post_id,
    recipient_student_id: row.recipient_student_id,
    score: row.score,
    channel: row.channel,
    status: row.status,
    sent_at: row.sent_at,
  })
  if (error) throw new Error(`recordPing insert failed: ${error.message}`)
}

async function deliver(handle: string, bubbles: string[]): Promise<void> {
  // Lazy import to break the circular dependency (same as squad-ping-deps).
  const { getActiveSpectrumClient } = await import('../adapters/spectrum.js')
  const c = getActiveSpectrumClient()
  if (!c) throw new Error('no_spectrum_connection')
  await c.sendProactive(handle, bubbles)
}

// ─── concierge-specific ──────────────────────────────────────────────────────
async function insertProposal(row: {
  student_id: string
  post_id: string
  fit_score: number
  reason: string | null
  approve_token: string
}): Promise<string | null> {
  const { data, error } = await supabase
    .from('proposed_matches')
    .insert({
      student_id: row.student_id,
      post_id: row.post_id,
      fit_score: row.fit_score,
      reason: row.reason,
      approve_token: row.approve_token,
    })
    .select('id')
    .single()
  if (error) {
    // 23505 = unique_violation on uq_proposed_matches_live → a live proposal already exists for
    // this (student, post). Idempotent no-op skip (engine drops it from the officer notify).
    if ((error as { code?: string }).code === '23505') return null
    throw new Error(`insertProposal failed: ${error.message}`)
  }
  return (data as { id: string }).id
}

const PROPOSAL_COLS = 'id, student_id, post_id, fit_score, reason, status'

async function claimProposal(id: string, officerId: string | null): Promise<Proposal | null> {
  // Atomic claim: only transition if STILL pending. Two concurrent approvals (link tap + iMessage
  // /ok) race here; exactly one updates a row, the other gets null → no double intro.
  const { data, error } = await supabase
    .from('proposed_matches')
    .update({ status: 'approved', officer_id: officerId, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select(PROPOSAL_COLS)
    .maybeSingle()
  if (error) throw new Error(`claimProposal failed: ${error.message}`)
  return (data as Proposal) ?? null
}

async function rejectProposal(id: string, officerId: string | null): Promise<boolean> {
  const { data, error } = await supabase
    .from('proposed_matches')
    .update({ status: 'rejected', officer_id: officerId, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`rejectProposal failed: ${error.message}`)
  return !!data
}

async function finalizeProposal(id: string, status: 'sent' | 'expired'): Promise<void> {
  // Only an approved (claimed) proposal reaches finalize; guard so a stray call can't resurrect a
  // rejected/expired row.
  const { error } = await supabase
    .from('proposed_matches')
    .update({ status })
    .eq('id', id)
    .eq('status', 'approved')
  if (error) throw new Error(`finalizeProposal failed: ${error.message}`)
}

async function isPostOpen(postId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('squad_posts')
    .select('current_people, max_people, deadline, completed_at, cancelled_at')
    .eq('id', postId)
    .single()
  if (error || !data) return false // fail closed — never intro into an unknown/closed post
  const p = data as {
    current_people: number | null
    max_people: number | null
    deadline: string | null
    completed_at: string | null
    cancelled_at: string | null
  }
  const notClosed = !p.cancelled_at && !p.completed_at
  const hasRoom = (p.current_people ?? 0) < (p.max_people ?? 0)
  const notExpired = !p.deadline || new Date(p.deadline).getTime() > Date.now()
  return notClosed && hasRoom && notExpired
}

// Recipient intro bubbles — same 局 copy as squad-ping-deps.composePing, but built at SEND time from
// the stored reason (matched_tag captured at propose) since the candidate object is long gone.
// Exported for the voice lint (tests/eval/voice-backtranslate.test.ts).
export function composeIntroFor(copy: PostCopy | null, reason: string | null): string[] {
  const cat = copy?.category ?? '活动'
  // Speech, never UI notation (mirrors composePingBubbles — same founder ruling 2026-07-01).
  const locPhrase = copy?.location ? `在${copy.location}` : ''
  const current = copy?.current_people ?? 1
  const max = copy?.max_people ?? 2
  const need = Math.max(1, max - current)
  const bubble1 = `诶 有人${locPhrase}组了个${cat}局 还缺${need}个人`
  const r = reason ?? '类似的'
  // 想去 carries the opt-out on its own (see squad-ping-deps composePing — same founder ruling).
  const bubble2 = `你之前提到${r} 想去我帮你报名哈哈`
  return [bubble1, bubble2]
}

// Build the ProposalDeps for a specific post. `copy` is loaded once for composeIntro + postCategory.
export async function buildProposalDeps(postId: string): Promise<ProposalDeps> {
  const copy = await loadPostCopy(postId)
  return {
    matchUsers,
    loadPrefs,
    countSentThisWeek,
    handleFor,
    recordPing,
    deliver,
    nowHourLA,
    postCategory: copy?.category ?? undefined,
    insertProposal,
    claimProposal,
    rejectProposal,
    finalizeProposal,
    isPostOpen,
    composeIntro: async (proposal: Proposal) => {
      // The approve path builds deps by proposal.post_id, so `copy` already matches; reload only if not.
      const c = proposal.post_id === postId ? copy : await loadPostCopy(proposal.post_id)
      return composeIntroFor(c, proposal.reason)
    },
    logFunnel: (studentId, stage, refId, meta) => logFunnelEvent(studentId, stage, { refId, meta }),
    newToken: () => randomUUID(),
    maxProposals: MAX_PROPOSALS_PER_POST,
  }
}

// Officer notify: ONE message per fan-out with an approve link + the /ok shortcut per match. Sent
// out-of-band to the officer handle — recipient identity may appear ONLY here (never in the
// create_squad_post tool return). No-op if no officer handle configured.
async function notifyOfficer(postId: string, summaries: ProposalSummary[]): Promise<void> {
  const officer = config.concierge.officerImessage
  if (!officer || summaries.length === 0) return
  const copy = await loadPostCopy(postId)
  const cat = copy?.category ?? '活动'
  const base = config.concierge.publicBaseUrl.replace(/\/+$/, '')
  const lines = summaries.map((s) => {
    const short = s.id.slice(0, 8)
    const reason = s.candidate.matched_tags?.[0] ?? s.candidate.best_facet ?? '类似的'
    const who = s.student_id.slice(0, 8)
    const link = base
      ? `${base}/admin/api/match/${s.id}/approve?k=${s.approve_token}`
      : '(set CONCIERGE_PUBLIC_BASE_URL)'
    return `· 学生 ${who} · ${reason} (fit ${s.fit_score.toFixed(2)})\n  同意: ${link}\n  或回复  /ok ${short}   拒绝  /no ${short}`
  })
  const bubbles = [`新${cat}局有 ${summaries.length} 个匹配等你过目 👀`, lines.join('\n')]
  try {
    await deliver(normalizeHandle(officer), bubbles)
  } catch (e) {
    console.error('concierge officer notify failed', { postId, err: (e as Error).message })
  }
}

// Convenience wrapper called from create-squad-post when CONCIERGE_MATCH_ENABLED=true.
// Returns the number of NEW proposals queued — used as the aggregate `reach`, never recipient ids.
export async function proposeMatchesForPost(postId: string): Promise<number> {
  const deps = await buildProposalDeps(postId)
  const summaries = await proposeMatches(postId, deps)
  if (summaries.length > 0) await notifyOfficer(postId, summaries)
  return summaries.length
}

export interface ProactiveProposal {
  id: string
  student_id: string
  post_id: string
  fit_score: number
  reason: string | null
  approve_token: string
}

// A student is eligible to be PROPOSED an existing post only if they neither created it nor already
// joined it. hybrid_search_posts_for_user returns neither fact (post_id/rrf_score only), so we check
// here — the guard squad-coordinator-deps pairs with the same open-post derivation.
export async function isStudentEligibleForPost(studentId: string, postId: string): Promise<boolean> {
  const [{ data: post }, { data: member }] = await Promise.all([
    supabase.from('squad_posts').select('created_by_student_id').eq('id', postId).single(),
    supabase.from('squad_members').select('student_id').eq('post_id', postId).eq('student_id', studentId).maybeSingle(),
  ])
  if (!post) return false // unknown post → fail closed
  if ((post as { created_by_student_id: string | null }).created_by_student_id === studentId) return false // own post
  if (member) return false // already joined
  return true
}

// T7 proactive squad branch: propose ONE passive student for an EXISTING open post (inverse of
// proposeMatchesForPost). Inserts + logs funnel; does NOT notify — the caller BATCHES notifications
// (via notifyOfficerDigest) so a run of N students is one officer message, not N. Returns the
// proposal, or null if a live one already exists / on error. Idempotent via the partial-unique index.
export async function proposeStudentForPost(
  studentId: string,
  postId: string,
  fitScore: number,
  reason: string | null,
): Promise<ProactiveProposal | null> {
  try {
    const approve_token = randomUUID()
    const id = await insertProposal({ student_id: studentId, post_id: postId, fit_score: fitScore, reason, approve_token })
    if (!id) return null // a live proposal for (student, post) already exists — skip
    await logFunnelEvent(studentId, 'match_proposed', { refId: postId, meta: { fit_score: fitScore, proactive: true } })
    return { id, student_id: studentId, post_id: postId, fit_score: fitScore, reason, approve_token }
  } catch (e) {
    console.error('proposeStudentForPost failed', { studentId, postId, err: (e as Error).message })
    return null
  }
}

// ONE officer digest for a whole proactive run (fixes per-student notify spam).
export async function notifyOfficerDigest(items: ProactiveProposal[]): Promise<void> {
  const officer = config.concierge.officerImessage
  if (!officer || items.length === 0) return
  const base = config.concierge.publicBaseUrl.replace(/\/+$/, '')
  const lines = items.map((it) => {
    const short = it.id.slice(0, 8)
    const who = it.student_id.slice(0, 8)
    const reason = it.reason ?? '类似的'
    const link = base ? `${base}/admin/api/match/${it.id}/approve?k=${it.approve_token}` : '(set CONCIERGE_PUBLIC_BASE_URL)'
    return `· 学生 ${who} · ${reason} (fit ${it.fit_score.toFixed(2)})\n  同意: ${link}\n  或回复  /ok ${short}   拒绝  /no ${short}`
  })
  const bubbles = [`有 ${items.length} 个新搭子匹配等你过目 👀`, lines.join('\n\n')]
  try {
    await deliver(normalizeHandle(officer), bubbles)
  } catch (e) {
    console.error('concierge officer digest failed', { err: (e as Error).message })
  }
}
