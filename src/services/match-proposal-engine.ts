// src/services/match-proposal-engine.ts
// Concierge match glance — the SPLIT of runPingFanout's fused propose+deliver into two phases so a
// human (officer) can approve each squad MATCH before George fires the intro. Squad lane ONLY;
// the event lane is governed upstream at event_submissions and never touches this engine.
//
// This is the pure, unit-tested core (mirrors squad-ping-engine.ts). All I/O is injected via
// ProposalDeps; the real wiring (Supabase + Spectrum) lives in match-proposal-deps.ts.
//
//   PROPOSE  proposeMatches(postId): rank candidates (match_users_for_post ALREADY enforces
//            pings_enabled at the SQL layer), take top-N, write a pending proposed_matches row +
//            funnel 'match_proposed'. NO delivery and NO runtime gates here — consent can change
//            between propose and approve, so gates run at SEND. Returns summaries so the caller
//            notifies the officer once. Idempotent: insertProposal returns null on a live conflict.
//   SEND     sendApprovedMatch(id, officerId): atomically CLAIM the proposal (pending→approved) so a
//            link tap and an iMessage /ok can't double-fire, then re-run the EXACT gate sequence from
//            runPingFanout (pings_enabled → category → cap → quiet-hours → post-still-open → handle)
//            and deliver with the same delivery-vs-record error separation. Records into squad_pings
//            so the shared weekly cap stays consistent across the auto and concierge lanes.
//   REJECT   rejectMatch(id, officerId): atomically pending→rejected.
//
// Reuses inQuietHours + the MatchCandidate/MatchPrefs/PingRow types from squad-ping-engine.

import { inQuietHours } from './squad-ping-engine.js'
import type { MatchCandidate, MatchPrefs, PingRow } from './squad-ping-engine.js'

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'expired'

export interface Proposal {
  id: string
  student_id: string
  post_id: string
  fit_score: number
  reason: string | null
  status: ProposalStatus
}

export interface ProposalSummary {
  id: string
  student_id: string
  fit_score: number
  approve_token: string
  candidate: MatchCandidate
}

export type FunnelStage = 'match_proposed' | 'match_approved' | 'intro_sent'

export type SendOutcome =
  | { outcome: 'sent' }
  | { outcome: 'expired'; reason: PingRow['status'] | 'post_closed' }
  | { outcome: 'noop'; reason: 'not_pending' }

export interface ProposalDeps {
  // ---- lifted verbatim from squad-ping-deps (same consent/ledger model) ----
  matchUsers: (postId: string) => Promise<MatchCandidate[]>
  loadPrefs: (studentId: string) => Promise<MatchPrefs | null>
  countSentThisWeek: (studentId: string) => Promise<number>
  handleFor: (studentId: string) => Promise<string | null>
  recordPing: (row: PingRow) => Promise<void>
  deliver: (handle: string, bubbles: string[]) => Promise<void>
  nowHourLA: () => number
  postCategory?: string
  // ---- concierge-specific ----
  // Insert a pending proposal. Returns the new id, or null when a LIVE (pending/sent) proposal for
  // this (student, post) already exists (partial-unique index) — an idempotent no-op skip.
  insertProposal: (row: {
    student_id: string
    post_id: string
    fit_score: number
    reason: string | null
    approve_token: string
  }) => Promise<string | null>
  // Atomically transition pending→approved and return the fresh row, or null if it was not pending
  // (already claimed/decided). This is the race guard for the link-tap + iMessage-/ok double approve.
  claimProposal: (id: string, officerId: string | null) => Promise<Proposal | null>
  // Atomically transition pending→rejected. Returns true if it claimed the row.
  rejectProposal: (id: string, officerId: string | null) => Promise<boolean>
  // Transition approved→sent | approved→expired (terminal).
  finalizeProposal: (id: string, status: 'sent' | 'expired') => Promise<void>
  // The activity must still be open at send: not cancelled, not completed, current_people<max_people,
  // (deadline null OR future). Reads all 5 columns (see squad-coordinator-deps).
  isPostOpen: (postId: string) => Promise<boolean>
  // Recipient intro bubbles — post-copy-specific (Chinese 局 copy), lives in deps like composePing.
  composeIntro: (proposal: Proposal) => Promise<string[]>
  logFunnel: (studentId: string, stage: FunnelStage, refId: string, meta?: Record<string, unknown>) => Promise<void>
  newToken: () => string
  maxProposals: number
}

/**
 * PROPOSE: rank and queue the top-N candidates for the officer glance. No delivery, no gates.
 * Returns the newly-created proposals (already-live ones are skipped idempotently) so the caller
 * can notify the officer exactly once. Empty array = no candidates (caller does the fallback).
 */
export async function proposeMatches(postId: string, deps: ProposalDeps): Promise<ProposalSummary[]> {
  const candidates = (await deps.matchUsers(postId))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, deps.maxProposals)

  const summaries: ProposalSummary[] = []
  for (const c of candidates) {
    try {
      const approve_token = deps.newToken()
      const reason = c.matched_tags?.[0] ?? c.best_facet ?? '类似的'
      const id = await deps.insertProposal({
        student_id: c.student_id,
        post_id: postId,
        fit_score: c.rrf_score,
        reason,
        approve_token,
      })
      if (!id) continue // a live proposal for (student, post) already exists — idempotent skip
      await deps.logFunnel(c.student_id, 'match_proposed', postId, { fit_score: c.rrf_score })
      summaries.push({ id, student_id: c.student_id, fit_score: c.rrf_score, approve_token, candidate: c })
    } catch {
      // One candidate's insert/log throwing (a non-23505 DB error) must NOT abort the fan-out and
      // drop the officer notify for the other candidates. Skip this one and continue.
    }
  }
  return summaries
}

/**
 * SEND: officer approved. Claim the proposal atomically, re-run the full consent gate sequence
 * (same order + the category gate the draft omitted), enforce post-still-open, then deliver with
 * the delivery-vs-record error separation from runPingFanout. Idempotent under concurrent approve.
 */
export async function sendApprovedMatch(
  proposalId: string,
  officerId: string | null,
  deps: ProposalDeps,
): Promise<SendOutcome> {
  const p = await deps.claimProposal(proposalId, officerId) // pending→approved, or null if not pending
  if (!p) return { outcome: 'noop', reason: 'not_pending' }

  // The proposal is now claimed to 'approved'. From here a throw would strand it in 'approved'
  // permanently (claimProposal only re-claims 'pending', so /ok + the link would both become no-ops).
  // So the status log and every finalize below are best-effort — a DB blip must not strand the row.
  try { await deps.logFunnel(p.student_id, 'match_approved', p.post_id, { approved: true }) } catch { /* best-effort */ }

  const prefs = await deps.loadPrefs(p.student_id)
  const record = (status: PingRow['status']) =>
    deps.recordPing({
      post_id: p.post_id,
      recipient_student_id: p.student_id,
      score: p.fit_score,
      channel: prefs?.channel ?? 'imessage',
      status,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    })

  // Gate failure: record the squad_pings suppression (best-effort, for cross-lane accounting) and
  // mark the proposal expired. Never throws out of the accounting write.
  const expire = async (
    reason: PingRow['status'] | 'post_closed',
    recordStatus?: PingRow['status'],
  ): Promise<SendOutcome> => {
    if (recordStatus) {
      try { await record(recordStatus) } catch { /* accounting best-effort — never block the expire */ }
    }
    try { await deps.finalizeProposal(p.id, 'expired') } catch { /* best-effort — don't strand as 'approved' */ }
    return { outcome: 'expired', reason }
  }

  // Re-check consent — it may have changed since the proposal was created (defense in depth;
  // match_users_for_post enforced it at propose time, this is the send-time re-check).
  if (!prefs || !prefs.pings_enabled) return expire('suppressed_muted', 'suppressed_muted')
  // Category scoping — the 5th gate (squad-ping-engine.ts:59-60). A muted-category student must
  // not receive an approved intro.
  if (
    prefs.allowed_categories &&
    deps.postCategory &&
    !prefs.allowed_categories.includes(deps.postCategory)
  ) {
    return expire('suppressed_muted', 'suppressed_muted')
  }
  // Weekly cap (counts squad_pings status='sent' across BOTH lanes).
  if ((await deps.countSentThisWeek(p.student_id)) >= prefs.weekly_ping_cap) {
    return expire('suppressed_cap', 'suppressed_cap')
  }
  // Quiet hours.
  if (inQuietHours(deps.nowHourLA(), prefs.quiet_start_hour, prefs.quiet_end_hour)) {
    return expire('suppressed_quiet_hours', 'suppressed_quiet_hours')
  }
  // Concierge-specific: the activity must still be open (no point intro'ing a full/expired 局).
  // Not a squad_pings suppression status, so no ledger row — proposed_matches='expired' records it.
  if (!(await deps.isPostOpen(p.post_id))) return expire('post_closed')
  // Deliverable channel.
  const handle = await deps.handleFor(p.student_id)
  if (!handle) return expire('suppressed_no_channel', 'suppressed_no_channel')

  // Delivery and recording are separate concerns (mirror runPingFanout:67-86): a delivered intro
  // is NEVER relabeled suppressed_no_channel because a row write failed, and a record failure must
  // not abort or double-send.
  let delivered = false
  try {
    await deps.deliver(handle, await deps.composeIntro(p))
    delivered = true
  } catch {
    delivered = false
  }
  if (!delivered) {
    try { await record('suppressed_no_channel') } catch { /* best-effort */ }
    await deps.finalizeProposal(p.id, 'expired')
    return { outcome: 'expired', reason: 'suppressed_no_channel' }
  }
  try {
    await record('sent')
  } catch {
    // Delivered, but the squad_pings write failed: keep the send, never relabel it.
  }
  // The intro is already delivered. A blip finalizing the status or logging the funnel must NOT
  // surface a delivered intro as an error, nor abort. Best-effort: the row may stay 'approved', but
  // claimProposal's status='pending' guard means it can never re-send.
  try { await deps.finalizeProposal(p.id, 'sent') } catch { /* delivered — status is best-effort */ }
  try { await deps.logFunnel(p.student_id, 'intro_sent', p.post_id) } catch { /* delivered — log is best-effort */ }
  return { outcome: 'sent' }
}

/**
 * REJECT: officer declined. Atomic pending→rejected; the proposed_matches='rejected' row is the record.
 */
export async function rejectMatch(
  proposalId: string,
  officerId: string | null,
  deps: ProposalDeps,
): Promise<{ outcome: 'rejected' | 'noop' }> {
  const ok = await deps.rejectProposal(proposalId, officerId)
  return { outcome: ok ? 'rejected' : 'noop' }
}
