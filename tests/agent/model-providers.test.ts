// tests/agent/model-providers.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { providerEnvForModel, providerOptionsForModel } from '../../src/agent/model-providers'

const KEY = 'DOUBAO_API_KEY'
const URL = 'DOUBAO_BASE_URL'

describe('providerEnvForModel — per-model provider routing', () => {
  const original = { key: process.env[KEY], url: process.env[URL] }
  afterEach(() => {
    if (original.key === undefined) delete process.env[KEY]; else process.env[KEY] = original.key
    if (original.url === undefined) delete process.env[URL]; else process.env[URL] = original.url
  })

  it('routes a doubao model to Ark when DOUBAO_API_KEY is set', () => {
    process.env[KEY] = 'sk-ark-test'
    const env = providerEnvForModel('doubao-seed-1.6')
    expect(env).not.toBeNull()
    expect(env!.ANTHROPIC_BASE_URL).toContain('ark.cn-beijing.volces.com')
    expect(env!.ANTHROPIC_AUTH_TOKEN).toBe('sk-ark-test')
    expect(env!.ANTHROPIC_API_KEY).toBe('sk-ark-test')
  })

  it('honors a custom DOUBAO_BASE_URL', () => {
    process.env[KEY] = 'sk-ark-test'
    process.env[URL] = 'https://custom.ark.example/api/coding'
    expect(providerEnvForModel('ark-code-latest')!.ANTHROPIC_BASE_URL).toBe('https://custom.ark.example/api/coding')
  })

  it('falls back to the global gateway (null) when DOUBAO_API_KEY is missing', () => {
    delete process.env[KEY]
    expect(providerEnvForModel('doubao-seed-1.6')).toBeNull()
  })

  it('returns null for non-doubao models (claude/deepseek use the global default)', () => {
    process.env[KEY] = 'sk-ark-test'
    expect(providerEnvForModel('claude-sonnet-4-6')).toBeNull()
    expect(providerEnvForModel('deepseek-v4-pro')).toBeNull()
    expect(providerEnvForModel(undefined)).toBeNull()
  })

  it('routes kimi/moonshot models to the Moonshot Anthropic endpoint when KIMI_API_KEY is set', () => {
    const orig = { k: process.env.KIMI_API_KEY, u: process.env.KIMI_ANTHROPIC_BASE_URL }
    try {
      process.env.KIMI_API_KEY = 'sk-kimi-test'
      delete process.env.KIMI_ANTHROPIC_BASE_URL
      const env = providerEnvForModel('kimi-k2-turbo-preview')
      expect(env).not.toBeNull()
      expect(env!.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
      expect(env!.ANTHROPIC_AUTH_TOKEN).toBe('sk-kimi-test')
      expect(providerEnvForModel('moonshot-v1-8k')).not.toBeNull()
      process.env.KIMI_ANTHROPIC_BASE_URL = 'https://custom.moonshot.example/anthropic'
      expect(providerEnvForModel('kimi-k2-turbo-preview')!.ANTHROPIC_BASE_URL).toBe('https://custom.moonshot.example/anthropic')
      delete process.env.KIMI_API_KEY
      expect(providerEnvForModel('kimi-k2-turbo-preview')).toBeNull()
    } finally {
      if (orig.k === undefined) delete process.env.KIMI_API_KEY; else process.env.KIMI_API_KEY = orig.k
      if (orig.u === undefined) delete process.env.KIMI_ANTHROPIC_BASE_URL; else process.env.KIMI_ANTHROPIC_BASE_URL = orig.u
    }
  })

  it('providerOptionsForModel: {} for default models (keeps query options byte-identical), {env} for doubao', () => {
    process.env[KEY] = 'sk-ark-test'
    expect(providerOptionsForModel('claude-sonnet-4-6')).toEqual({})
    const opts = providerOptionsForModel('doubao-seed-1.6')
    expect(opts.env).toBeDefined()
    expect(opts.env!.ANTHROPIC_AUTH_TOKEN).toBe('sk-ark-test')
    // includes the rest of process.env (the SDK subprocess needs it)
    expect(opts.env!.PATH ?? opts.env!.HOME ?? 'present').toBeTruthy()
  })
})
