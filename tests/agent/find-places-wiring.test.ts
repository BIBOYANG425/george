// tests/agent/find-places-wiring.test.ts
import { describe, it, expect } from 'vitest'
import { ALL_TOOLS } from '../../src/tools/index.js'
import { SUB_AGENTS } from '../../src/agent/agents.config.js'

describe('find_places wiring', () => {
  it('is registered in ALL_TOOLS', () => {
    expect((ALL_TOOLS as Record<string, unknown>).find_places).toBeDefined()
  })
  it('is listed by whats-happening and know-things, not find-people', () => {
    expect(SUB_AGENTS['whats-happening'].tools).toContain('find_places')
    expect(SUB_AGENTS['know-things'].tools).toContain('find_places')
    expect(SUB_AGENTS['find-people'].tools).not.toContain('find_places')
  })
})
