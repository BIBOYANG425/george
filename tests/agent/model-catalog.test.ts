// tests/agent/model-catalog.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { availableModels, MODEL_CATALOG } from '../../src/agent/model-catalog'

// availableModels is a pure function of process.env — set/unset provider keys and
// assert which catalog rows surface. Restore env after each test.
const KEYS = ['ANTHROPIC_API_KEY', 'DOUBAO_API_KEY', 'DOUBAO_MODEL', 'ANTHROPIC_BASE_URL']

describe('availableModels — env-gated model catalog', () => {
  const original: Record<string, string | undefined> = {}
  for (const k of KEYS) original[k] = process.env[k]
  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k]
      else process.env[k] = original[k]
    }
  })

  it('hides doubao MAIN until DOUBAO_API_KEY is set, then surfaces it', () => {
    delete process.env.DOUBAO_API_KEY
    expect(availableModels('main').some((m) => m.id === 'doubao-seed-1.6')).toBe(false)
    process.env.DOUBAO_API_KEY = 'k'
    expect(availableModels('main').some((m) => m.id === 'doubao-seed-1.6')).toBe(true)
  })

  it('doubao EMOTIONAL needs BOTH DOUBAO_API_KEY and DOUBAO_MODEL', () => {
    process.env.DOUBAO_API_KEY = 'k'
    delete process.env.DOUBAO_MODEL
    expect(availableModels('emotional').some((m) => m.id === 'doubao-seed-2-0-lite-260215')).toBe(false)
    process.env.DOUBAO_MODEL = 'doubao-seed-2-0-lite-260215'
    expect(availableModels('emotional').some((m) => m.id === 'doubao-seed-2-0-lite-260215')).toBe(true)
  })

  it('filters by tier — doubao-seed-1.6 is main-only, never emotional', () => {
    process.env.DOUBAO_API_KEY = 'k'
    process.env.DOUBAO_MODEL = 'x'
    expect(availableModels('emotional').some((m) => m.id === 'doubao-seed-1.6')).toBe(false)
    expect(availableModels('main').some((m) => m.id === 'doubao-seed-1.6')).toBe(true)
  })

  it('claude shows on both tiers with ANTHROPIC_API_KEY, hides without', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    expect(availableModels('main').some((m) => m.id === 'claude-sonnet-4-6')).toBe(true)
    expect(availableModels('emotional').some((m) => m.id === 'claude-sonnet-4-6')).toBe(true)
    delete process.env.ANTHROPIC_API_KEY
    expect(availableModels('main').some((m) => m.id === 'claude-sonnet-4-6')).toBe(false)
  })

  it('every catalog row declares valid tiers and at least one required env var', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.tiers.length).toBeGreaterThan(0)
      for (const t of m.tiers) expect(['main', 'emotional']).toContain(t)
      expect(m.requiresEnv.length).toBeGreaterThan(0)
    }
  })
})
