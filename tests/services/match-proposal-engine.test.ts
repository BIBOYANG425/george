import { describe, expect, it, vi } from 'vitest'
import {
  proposeMatches,
  sendApprovedMatch,
  rejectMatch,
  type ProposalDeps,
  type Proposal,
} from '../../src/services/match-proposal-engine'

const CAND = (id: string, score = 0.05) => ({
  student_id: id,
  rrf_score: score,
  semantic_sim: 0.7,
  tag_overlap: 1,
  matched_tags: ['hiking'],
  best_facet: 'hiking',
})

const PREFS = (over: Record<string, unknown> = {}) => ({
  student_id: 's1',
  pings_enabled: true,
  weekly_ping_cap: 3,
  quiet_start_hour: 23,
  quiet_end_hour: 9,
  allowed_categories: null as string[] | null,
  channel: 'imessage',
  ...over,
})

const CLAIMED = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  student_id: 's1',
  post_id: 'post-1',
  fit_score: 0.05,
  reason: 'hiking',
  status: 'approved',
  ...over,
})

type Caps = {
  inserted: any[]
  funnel: any[]
  records: any[]
  delivered: any[]
  finalized: any[]
}

function deps(over: Partial<ProposalDeps> = {}): ProposalDeps & Caps {
  const inserted: any[] = []
  const funnel: any[] = []
  const records: any[] = []
  const delivered: any[] = []
  const finalized: any[] = []
  let pid = 0
  let tok = 0
  const base: ProposalDeps = {
    matchUsers: vi.fn(async () => [CAND('s1', 0.05), CAND('s2', 0.04)]),
    loadPrefs: vi.fn(async (id: string) => PREFS({ student_id: id })),
    countSentThisWeek: vi.fn(async () => 0),
    handleFor: vi.fn(async (id: string) => `+1555000${id.slice(-1)}`),
    recordPing: vi.fn(async (row: any) => {
      records.push(row)
    }),
    deliver: vi.fn(async (handle: string, bubbles: string[]) => {
      delivered.push({ handle, bubbles })
    }),
    nowHourLA: () => 14,
    postCategory: '自习',
    insertProposal: vi.fn(async (row: any) => {
      const id = `p${++pid}`
      inserted.push({ id, ...row })
      return id
    }),
    claimProposal: vi.fn(async (id: string) => CLAIMED({ id })),
    rejectProposal: vi.fn(async () => true),
    finalizeProposal: vi.fn(async (id: string, status: string) => {
      finalized.push({ id, status })
    }),
    isPostOpen: vi.fn(async () => true),
    composeIntro: vi.fn(async () => ['诶 有人组了局', '你之前提到hiking 想去我帮你报名']),
    logFunnel: vi.fn(async (studentId: string, stage: string, refId: string, meta?: any) => {
      funnel.push({ studentId, stage, refId, meta })
    }),
    newToken: () => `tok-${++tok}`,
    maxProposals: 3,
  }
  return Object.assign(base, over, { inserted, funnel, records, delivered, finalized }) as ProposalDeps & Caps
}

const stages = (d: Caps) => d.funnel.map((f) => f.stage)

describe('proposeMatches', () => {
  it('ranks top-N, inserts pending, logs match_proposed, returns summaries', async () => {
    const d = deps()
    const summaries = await proposeMatches('post-1', d)
    expect(summaries).toHaveLength(2)
    expect(d.inserted).toHaveLength(2)
    expect(stages(d).filter((s) => s === 'match_proposed')).toHaveLength(2)
    // reason captured from the top matched_tag for the recipient intro later
    expect(d.inserted[0].reason).toBe('hiking')
    // NO delivery and NO squad_pings write at propose time
    expect(d.delivered).toHaveLength(0)
    expect(d.records).toHaveLength(0)
  })

  it('idempotent skip: a live-conflict insert (null) drops that candidate from the notify', async () => {
    const d = deps({ insertProposal: vi.fn(async (row: any) => (row.student_id === 's2' ? null : 'p1')) })
    const summaries = await proposeMatches('post-1', d)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].student_id).toBe('s1')
    expect(stages(d).filter((s) => s === 'match_proposed')).toHaveLength(1)
  })

  it('empty candidate pool → [] (caller does the event/solo fallback, never an empty match)', async () => {
    const d = deps({ matchUsers: vi.fn(async () => []) })
    const summaries = await proposeMatches('post-1', d)
    expect(summaries).toEqual([])
    expect(d.inserted).toHaveLength(0)
    expect(d.funnel).toHaveLength(0)
  })

  it('respects maxProposals, ordered by rrf_score desc', async () => {
    const d = deps({ maxProposals: 1 })
    const summaries = await proposeMatches('post-1', d)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].student_id).toBe('s1') // 0.05 > 0.04
  })
})

describe('sendApprovedMatch', () => {
  it('happy path: claim → gates pass → deliver → record sent → finalize sent → intro_sent', async () => {
    const d = deps()
    const res = await sendApprovedMatch('p1', 'officer@x', d)
    expect(res).toEqual({ outcome: 'sent' })
    expect(d.delivered).toHaveLength(1)
    expect(d.records).toEqual([expect.objectContaining({ status: 'sent' })])
    expect(d.finalized).toEqual([{ id: 'p1', status: 'sent' }])
    expect(stages(d)).toContain('match_approved')
    expect(stages(d)).toContain('intro_sent')
  })

  it('not pending (claim returns null): noop, no deliver', async () => {
    const d = deps({ claimProposal: vi.fn(async () => null) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'noop', reason: 'not_pending' })
    expect(d.delivered).toHaveLength(0)
    expect(d.finalized).toHaveLength(0)
  })

  it('consent revoked at send (pings_enabled=false): expired suppressed_muted, no deliver', async () => {
    const d = deps({ loadPrefs: vi.fn(async (id: string) => PREFS({ student_id: id, pings_enabled: false })) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'suppressed_muted' })
    expect(d.delivered).toHaveLength(0)
    expect(d.records).toEqual([expect.objectContaining({ status: 'suppressed_muted' })])
    expect(d.finalized).toEqual([{ id: 'p1', status: 'expired' }])
    expect(stages(d)).toContain('match_approved')
    expect(stages(d)).not.toContain('intro_sent')
  })

  it('category mute (5th gate): allowed_categories excludes post category → expired', async () => {
    const d = deps({
      loadPrefs: vi.fn(async (id: string) => PREFS({ student_id: id, allowed_categories: ['其它'] })),
      postCategory: '自习',
    })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'suppressed_muted' })
    expect(d.delivered).toHaveLength(0)
  })

  it('weekly cap reached → expired suppressed_cap', async () => {
    const d = deps({ countSentThisWeek: vi.fn(async () => 3) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'suppressed_cap' })
    expect(d.records).toEqual([expect.objectContaining({ status: 'suppressed_cap' })])
  })

  it('quiet hours → expired suppressed_quiet_hours', async () => {
    const d = deps({ nowHourLA: () => 2 })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'suppressed_quiet_hours' })
    expect(d.delivered).toHaveLength(0)
  })

  it('post closed/full → expired post_closed, NO squad_pings row', async () => {
    const d = deps({ isPostOpen: vi.fn(async () => false) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'post_closed' })
    expect(d.records).toHaveLength(0) // post_closed is not a ping suppression status
    expect(d.finalized).toEqual([{ id: 'p1', status: 'expired' }])
  })

  it('no handle → expired suppressed_no_channel (recorded)', async () => {
    const d = deps({ handleFor: vi.fn(async () => null) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'suppressed_no_channel' })
    expect(d.records).toEqual([expect.objectContaining({ status: 'suppressed_no_channel' })])
  })

  it('delivery failure → expired, recorded suppressed_no_channel, never sent', async () => {
    const d = deps({ deliver: vi.fn(async () => { throw new Error('queue down') }) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'expired', reason: 'suppressed_no_channel' })
    expect(d.records).toEqual([expect.objectContaining({ status: 'suppressed_no_channel' })])
    expect(d.finalized).toEqual([{ id: 'p1', status: 'expired' }])
  })

  it('delivered but recordPing(sent) throws: keep the send, never relabel', async () => {
    const d = deps({ recordPing: vi.fn(async () => { throw new Error('insert blip') }) })
    const res = await sendApprovedMatch('p1', null, d)
    expect(res).toEqual({ outcome: 'sent' })
    expect(d.delivered).toHaveLength(1)
    expect(d.finalized).toEqual([{ id: 'p1', status: 'sent' }])
  })

  it('double approve (link + /ok race): first sends, second is a noop, ONE intro', async () => {
    let claims = 0
    const d = deps({ claimProposal: vi.fn(async (id: string) => (claims++ === 0 ? CLAIMED({ id }) : null)) })
    const r1 = await sendApprovedMatch('p1', 'a', d)
    const r2 = await sendApprovedMatch('p1', 'b', d)
    expect(r1).toEqual({ outcome: 'sent' })
    expect(r2).toEqual({ outcome: 'noop', reason: 'not_pending' })
    expect(d.delivered).toHaveLength(1)
  })
})

describe('rejectMatch', () => {
  it('claimed pending → rejected', async () => {
    const d = deps()
    expect(await rejectMatch('p1', 'officer', d)).toEqual({ outcome: 'rejected' })
  })
  it('already decided (rejectProposal false) → noop', async () => {
    const d = deps({ rejectProposal: vi.fn(async () => false) })
    expect(await rejectMatch('p1', 'officer', d)).toEqual({ outcome: 'noop' })
  })
})
