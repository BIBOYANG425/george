import { describe, it, expect } from 'vitest'
import { SQUAD_CATEGORIES, normalizeSquadCategory } from '../../src/services/squad-categories.js'

describe('normalizeSquadCategory', () => {
  it('each postable enum value passes through unchanged', () => {
    for (const cat of SQUAD_CATEGORIES) {
      expect(normalizeSquadCategory(cat)).toBe(cat)
    }
  })

  it('约会 → { rejected: "romantic" }', () => {
    expect(normalizeSquadCategory('约会')).toEqual({ rejected: 'romantic' })
  })

  it('unknown string → 其它', () => {
    expect(normalizeSquadCategory('未知活动')).toBe('其它')
    expect(normalizeSquadCategory('party')).toBe('其它')
    expect(normalizeSquadCategory('')).toBe('其它')
    expect(normalizeSquadCategory('random')).toBe('其它')
  })

  it('SQUAD_CATEGORIES does not include 约会', () => {
    expect(SQUAD_CATEGORIES).not.toContain('约会')
  })
})
