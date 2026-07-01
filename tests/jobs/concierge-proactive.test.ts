import { describe, expect, it } from 'vitest'
import { selectSquadProposal, type RankedPost } from '../../src/jobs/concierge-proactive'

const P = (over: Partial<RankedPost> = {}): RankedPost => ({ post_id: 'x', rrf_score: 0.1, ...over })

describe('selectSquadProposal', () => {
  it('picks the highest-scoring post above the floor', () => {
    const r = selectSquadProposal([P({ post_id: 'a', rrf_score: 0.03 }), P({ post_id: 'b', rrf_score: 0.09 })])
    expect(r?.postId).toBe('b')
    expect(r?.fitScore).toBe(0.09)
  })

  it('returns null when everything is below the fit floor', () => {
    expect(selectSquadProposal([P({ rrf_score: 0.001 })], 0.02)).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(selectSquadProposal([])).toBeNull()
  })

  it('reason comes from matched_tags[0], then best_facet, then null', () => {
    expect(selectSquadProposal([P({ matched_tags: ['hiking'], best_facet: 'x' })])?.reason).toBe('hiking')
    expect(selectSquadProposal([P({ matched_tags: [], best_facet: 'coffee' })])?.reason).toBe('coffee')
    expect(selectSquadProposal([P({ matched_tags: null, best_facet: null })])?.reason).toBeNull()
  })

  it('ignores rows missing post_id (RPC returns post_id, not id)', () => {
    const r = selectSquadProposal([{ rrf_score: 0.9 } as RankedPost, P({ post_id: 'b', rrf_score: 0.05 })])
    expect(r?.postId).toBe('b')
  })

  it('treats a missing rrf_score as 0 → below floor', () => {
    expect(selectSquadProposal([{ post_id: 'a' }])).toBeNull()
  })
})
