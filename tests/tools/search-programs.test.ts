import { describe, it, expect, vi } from 'vitest'

// Mock the searchWithFallback helper so the test is hermetic (no live Supabase).
const mockSearch = vi.fn()
vi.mock('../../src/tools/search-helpers.js', () => ({
  searchWithFallback: mockSearch,
}))

describe('search_programs tool', () => {
  it('tool name is search_programs', async () => {
    const { searchProgramsTool } = await import('../../src/tools/search-programs.js')
    expect(searchProgramsTool.name).toBe('search_programs')
  })

  it('returns a not-found message when nothing matches', async () => {
    mockSearch.mockResolvedValueOnce([])
    const { searchProgramsHandler } = await import('../../src/tools/search-programs.js')
    const result = await searchProgramsHandler({ query: 'zzzzznonsense_xyz' })
    expect(result.toLowerCase()).toContain('no programs')
  })

  it('returns JSON on hits', async () => {
    mockSearch.mockResolvedValueOnce([
      { name: 'Accounting (BS)', degree_type: 'BS', school: 'USC Marshall School of Business', description: 'Accounting description.' },
    ])
    const { searchProgramsHandler } = await import('../../src/tools/search-programs.js')
    const result = await searchProgramsHandler({ query: 'accounting' })
    expect(result).toContain('Accounting (BS)')
    expect(result).toContain('Marshall')
  })
})
