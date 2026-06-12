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

  it('prefers SPECTRUM_PROJECT_ID but falls back to the scaffold PROJECT_ID', async () => {
    delete process.env.SPECTRUM_PROJECT_ID
    delete process.env.SPECTRUM_PROJECT_SECRET
    process.env.PROJECT_ID = 'scaffold-id'
    process.env.PROJECT_SECRET = 'scaffold-secret'
    let { loadTransportConfig } = await import('../src/config.js')
    expect(loadTransportConfig().spectrum.projectId).toBe('scaffold-id')
    expect(loadTransportConfig().spectrum.projectSecret).toBe('scaffold-secret')

    vi.resetModules()
    process.env.SPECTRUM_PROJECT_ID = 'namespaced-id'
    ;({ loadTransportConfig } = await import('../src/config.js'))
    expect(loadTransportConfig().spectrum.projectId).toBe('namespaced-id')

    delete process.env.PROJECT_ID
    delete process.env.PROJECT_SECRET
    delete process.env.SPECTRUM_PROJECT_ID
  })
})
