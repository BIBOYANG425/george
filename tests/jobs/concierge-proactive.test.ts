import { describe, expect, it } from 'vitest'
import { selectSquadProposal, type RankedPost } from '../../src/jobs/concierge-proactive'

const P = (over: Partial<RankedPost> = {}): RankedPost => ({
  id: 'x',
  created_by_student_id: 'other',
  rrf_score: 0.1,
  ...over,
})

describe('selectSquadProposal', () => {
  it('picks the highest-scoring eligible post', () => {
    const r = selectSquadProposal([P({ id: 'a', rrf_score: 0.03 }), P({ id: 'b', rrf_score: 0.09 })], 's1')
    expect(r?.postId).toBe('b')
    expect(r?.fitScore).toBe(0.09)
  })

  it("excludes the student's own posts", () => {
    const r = selectSquadProposal(
      [P({ id: 'mine', created_by_student_id: 's1', rrf_score: 0.9 }), P({ id: 'b', rrf_score: 0.03 })],
      's1',
    )
    expect(r?.postId).toBe('b')
  })

  it('returns null when everything is below the fit floor', () => {
    expect(selectSquadProposal([P({ rrf_score: 0.001 })], 's1', 0.02)).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(selectSquadProposal([], 's1')).toBeNull()
  })

  it('returns null when the only post is the student’s own (no self-match)', () => {
    expect(selectSquadProposal([P({ id: 'mine', created_by_student_id: 's1', rrf_score: 0.9 })], 's1')).toBeNull()
  })

  it('reason comes from matched_tags[0], then best_facet, then null', () => {
    expect(selectSquadProposal([P({ matched_tags: ['hiking'], best_facet: 'x' })], 's1')?.reason).toBe('hiking')
    expect(selectSquadProposal([P({ matched_tags: [], best_facet: 'coffee' })], 's1')?.reason).toBe('coffee')
    expect(selectSquadProposal([P({ matched_tags: null, best_facet: null })], 's1')?.reason).toBeNull()
  })

  it('falls back to the score field when rrf_score is absent', () => {
    const r = selectSquadProposal([{ id: 'a', created_by_student_id: 'o', score: 0.05 }], 's1')
    expect(r?.fitScore).toBe(0.05)
  })
})
