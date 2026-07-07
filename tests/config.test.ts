import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('config.transport', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    // Clear the vars this suite mutates so cases stay order-independent.
    for (const k of [
      'TRANSPORT',
      'SPECTRUM_PROJECT_ID',
      'SPECTRUM_PROJECT_SECRET',
      'PROJECT_ID',
      'PROJECT_SECRET',
    ]) {
      delete process.env[k]
    }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('defaults to legacy when TRANSPORT is unset', async () => {
    const { loadTransportConfig } = await import('../src/config.js')
    expect(loadTransportConfig().transport).toBe('legacy')
  })

  it('selects spectrum when TRANSPORT=spectrum (with creds)', async () => {
    process.env.TRANSPORT = 'spectrum'
    process.env.SPECTRUM_PROJECT_ID = 'pid'
    process.env.SPECTRUM_PROJECT_SECRET = 'psecret'
    const { loadTransportConfig } = await import('../src/config.js')
    expect(loadTransportConfig().transport).toBe('spectrum')
  })

  it('throws on an unsupported TRANSPORT value', async () => {
    // Import first so config.ts's dotenv.config() runs, then set the bad value
    // live — loadTransportConfig reads process.env at call time.
    const { loadTransportConfig } = await import('../src/config.js')
    process.env.TRANSPORT = 'webhook'
    expect(() => loadTransportConfig()).toThrow(/Invalid TRANSPORT/)
  })

  it('throws when TRANSPORT=spectrum but creds are missing', async () => {
    // Import first so dotenv.config() injects the real .env (which carries the
    // bare PROJECT_ID/PROJECT_SECRET scaffold names), THEN strip every cred so
    // they're absent at call time regardless of what .env holds.
    const { loadTransportConfig } = await import('../src/config.js')
    process.env.TRANSPORT = 'spectrum'
    delete process.env.SPECTRUM_PROJECT_ID
    delete process.env.SPECTRUM_PROJECT_SECRET
    delete process.env.PROJECT_ID
    delete process.env.PROJECT_SECRET
    expect(() => loadTransportConfig()).toThrow(/requires SPECTRUM_PROJECT_ID/)
  })

  it('prefers SPECTRUM_PROJECT_ID but falls back to the scaffold PROJECT_ID', async () => {
    process.env.PROJECT_ID = 'scaffold-id'
    process.env.PROJECT_SECRET = 'scaffold-secret'
    let { loadTransportConfig } = await import('../src/config.js')
    expect(loadTransportConfig().spectrum.projectId).toBe('scaffold-id')
    expect(loadTransportConfig().spectrum.projectSecret).toBe('scaffold-secret')

    vi.resetModules()
    process.env.SPECTRUM_PROJECT_ID = 'namespaced-id'
    ;({ loadTransportConfig } = await import('../src/config.js'))
    expect(loadTransportConfig().spectrum.projectId).toBe('namespaced-id')
  })
})

describe('config — lazy LLM/db getters (import side-effect free)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    // Present-but-empty so dotenv.config() (which never overrides an existing key)
    // leaves them empty — simulating a boot with no ANTHROPIC_API_KEY and not in
    // bridge mode, the exact case the dashboard service boots under.
    process.env.BACKEND_RELAY_URL = ''
    process.env.ANTHROPIC_API_KEY = ''
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('importing config does NOT throw when ANTHROPIC_API_KEY is unset', async () => {
    // The eager version threw here; the lazy getter defers the throw to first access.
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  it('throws only when the LLM key is actually accessed', async () => {
    const { config } = await import('../src/config.js')
    expect(() => config.anthropic.apiKey).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('returns the key once it is present (read per access)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-live'
    const { config } = await import('../src/config.js')
    expect(config.anthropic.apiKey).toBe('sk-live')
  })
})
