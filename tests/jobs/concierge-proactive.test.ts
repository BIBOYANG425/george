import { describe, expect, it } from 'vitest'
import { selectSquadCandidates, type RankedPost } from '../../src/jobs/concierge-proactive'

const P = (over: Partial<RankedPost> = {}): RankedPost => ({ post_id: 'x', rrf_score: 0.1, ...over })

describe('selectSquadCandidates', () => {
  it('ranks eligible-by-score posts, highest first', () => {
    const r = selectSquadCandidates([P({ post_id: 'a', rrf_score: 0.03 }), P({ post_id: 'b', rrf_score: 0.09 })])
    expect(r.map((x) => x.postId)).toEqual(['b', 'a'])
    expect(r[0].fitScore).toBe(0.09)
  })

  it('drops posts below the fit floor', () => {
    const r = selectSquadCandidates([P({ post_id: 'a', rrf_score: 0.001 }), P({ post_id: 'b', rrf_score: 0.05 })], 0.02)
    expect(r.map((x) => x.postId)).toEqual(['b'])
  })

  it('empty input → empty list', () => {
    expect(selectSquadCandidates([])).toEqual([])
  })

  it('ignores rows missing post_id (RPC returns post_id, not id)', () => {
    const r = selectSquadCandidates([{ rrf_score: 0.9 } as RankedPost, P({ post_id: 'b', rrf_score: 0.05 })])
    expect(r.map((x) => x.postId)).toEqual(['b'])
  })

  it('a missing rrf_score is treated as 0 → below floor', () => {
    expect(selectSquadCandidates([{ post_id: 'a' }])).toEqual([])
  })

  it('reason comes from matched_tags[0], then best_facet, then null', () => {
    expect(selectSquadCandidates([P({ matched_tags: ['hiking'], best_facet: 'x' })])[0].reason).toBe('hiking')
    expect(selectSquadCandidates([P({ matched_tags: [], best_facet: 'coffee' })])[0].reason).toBe('coffee')
    expect(selectSquadCandidates([P({ matched_tags: null, best_facet: null })])[0].reason).toBeNull()
  })
})
