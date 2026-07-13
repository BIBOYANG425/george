import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getObs, isObservabilityEnabled, outboundEvent, resolveChannel } from '../../src/observability/agent-obs/index.js'
import { mountAgentControlEndpoint } from '../../src/observability/agent-obs/control-endpoint.js'

const FLAG = 'GEORGE_MESSAGE_OBSERVABILITY_ENABLED'
const SECRET = 'AGENT_CONTROL_SECRET'

describe('agent-obs default-OFF safety', () => {
  const saved = { flag: process.env[FLAG], url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }
  beforeEach(() => {
    delete process.env[FLAG]
  })
  afterEach(() => {
    if (saved.flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved.flag
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key
  })

  it('is disabled when the flag is unset', () => {
    expect(isObservabilityEnabled()).toBe(false)
  })

  it('getObs() returns a no-op that never throws when disabled', async () => {
    const obs = getObs()
    expect(() => obs.logMessage({ conversationId: 'h', direction: 'inbound', platform: 'imessage' })).not.toThrow()
    expect(() => obs.upsertContact({ handle: 'h' })).not.toThrow()
    await expect(obs.resolveOutboundChannel('h')).resolves.toBe('unknown')
    await expect(obs.isOptedOut('h')).resolves.toBe(false)
    await expect(obs.seedChannelCache()).resolves.toBeUndefined()
  })

  it('stays a no-op when enabled but Supabase env is absent (bridge mode)', async () => {
    process.env[FLAG] = 'true'
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const obs = getObs()
    // No network client is created; calls remain safe.
    await expect(obs.isOptedOut('h')).resolves.toBe(false)
    expect(() => obs.logMessage({ conversationId: 'h', direction: 'outbound', platform: 'imessage' })).not.toThrow()
  })
})

describe('resolveChannel — determines the display channel', () => {
  it('maps platform → registry key (Spectrum exposes no sub-transport)', () => {
    // spectrum-ts cloud iMessage sets no service, so platform is the signal.
    expect(resolveChannel('iMessage')).toBe('iMessage')
    expect(resolveChannel('imessage')).toBe('iMessage') // case-insensitive
    expect(resolveChannel('whatsapp-business')).toBe('WhatsApp')
    expect(resolveChannel('whatsapp')).toBe('WhatsApp')
    expect(resolveChannel('telegram')).toBe('Telegram')
    expect(resolveChannel('wechat')).toBe('WeChat')
  })

  it('prefers an explicit service hint when a provider supplies one (future-proof)', () => {
    expect(resolveChannel('iMessage', 'SMS')).toBe('SMS')
    expect(resolveChannel('iMessage', 'rcs')).toBe('RCS')
    expect(resolveChannel('iMessage', 'iMessage')).toBe('iMessage')
  })

  it('never returns "unknown" for a known platform even with no service hint', () => {
    expect(resolveChannel('iMessage', undefined)).toBe('iMessage')
    expect(resolveChannel('iMessage', '')).toBe('iMessage')
  })

  it('falls back to the raw platform / unknown only when truly unclassifiable', () => {
    expect(resolveChannel('discord')).toBe('discord')
    expect(resolveChannel(undefined)).toBe('unknown')
    expect(resolveChannel('')).toBe('unknown')
  })
})

describe('outboundEvent mapping', () => {
  it('produces a normalized outbound message', () => {
    const e = outboundEvent('+15551234567', 'hi', 'iMessage', 'ext-1')
    expect(e).toMatchObject({
      conversationId: '+15551234567',
      direction: 'outbound',
      platform: 'imessage',
      channel: 'iMessage',
      text: 'hi',
      externalId: 'ext-1',
      contentType: 'text',
    })
  })
})

describe('control endpoint mounting decision', () => {
  const saved = { flag: process.env[FLAG], secret: process.env[SECRET] }
  function fakeApp() {
    const routes: string[] = []
    return {
      routes,
      get(path: string) { routes.push(`GET ${path}`) },
      post(path: string) { routes.push(`POST ${path}`) },
    }
  }
  afterEach(() => {
    if (saved.flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved.flag
    if (saved.secret === undefined) delete process.env[SECRET]; else process.env[SECRET] = saved.secret
  })

  it('mounts nothing when observability is disabled', () => {
    delete process.env[FLAG]
    process.env[SECRET] = 'shh'
    const app = fakeApp()
    mountAgentControlEndpoint(app as never)
    expect(app.routes).toEqual([])
  })

  it('mounts nothing when AGENT_CONTROL_SECRET is unset (opt-in)', () => {
    process.env[FLAG] = 'true'
    delete process.env[SECRET]
    const app = fakeApp()
    mountAgentControlEndpoint(app as never)
    expect(app.routes).toEqual([])
  })

  it('mounts /observ/send + /observ/health only when enabled AND a secret is set', () => {
    process.env[FLAG] = 'true'
    process.env[SECRET] = 'shh'
    const app = fakeApp()
    mountAgentControlEndpoint(app as never)
    expect(app.routes).toContain('POST /observ/send')
    expect(app.routes).toContain('GET /observ/health')
  })
})
