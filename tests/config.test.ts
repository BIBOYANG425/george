import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('config.transport', () => {
  beforeEach(() => { vi.resetModules() })

  it('defaults to legacy when TRANSPORT is unset', async () => {
    delete process.env.TRANSPORT
    const { loadTransportConfig } = await import('../src/config.js')
    expect(loadTransportConfig().transport).toBe('legacy')
  })

  it('selects spectrum when TRANSPORT=spectrum', async () => {
    process.env.TRANSPORT = 'spectrum'
    const { loadTransportConfig } = await import('../src/config.js')
    expect(loadTransportConfig().transport).toBe('spectrum')
  })
})
