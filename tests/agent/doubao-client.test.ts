// tests/agent/doubao-client.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { isDoubaoConfigured, doubaoChat } from '../../src/agent/doubao-client'

const ENV = ['DOUBAO_API_KEY', 'DOUBAO_MODEL', 'DOUBAO_BASE_URL', 'DOUBAO_REASONING_EFFORT'] as const

describe('doubao-client', () => {
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV) saved[k] = process.env[k]
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]! }
    vi.restoreAllMocks()
  })

  it('isDoubaoConfigured requires BOTH key and model', () => {
    delete process.env.DOUBAO_API_KEY; delete process.env.DOUBAO_MODEL
    expect(isDoubaoConfigured()).toBe(false)
    process.env.DOUBAO_API_KEY = 'sk-ark'
    expect(isDoubaoConfigured()).toBe(false)
    process.env.DOUBAO_MODEL = 'doubao-seed-1-6-lite-251015'
    expect(isDoubaoConfigured()).toBe(true)
  })

  it('posts OpenAI-format to /chat/completions and returns the content', async () => {
    process.env.DOUBAO_API_KEY = 'sk-ark'
    process.env.DOUBAO_MODEL = 'doubao-seed-1-6-lite-251015'
    delete process.env.DOUBAO_BASE_URL
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '哈哈哈在呢，咋啦' } }] }), { status: 200 }),
    )
    const out = await doubaoChat([{ role: 'user', content: 'hi' }], { maxTokens: 100 })
    expect(out).toBe('哈哈哈在呢，咋啦')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('doubao-seed-1-6-lite-251015')
    expect(body.max_tokens).toBe(100)
    expect(body.reasoning_effort).toBe('minimal')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-ark' })
  })

  it('honors a custom DOUBAO_BASE_URL', async () => {
    process.env.DOUBAO_API_KEY = 'sk-ark'
    process.env.DOUBAO_MODEL = 'm'
    process.env.DOUBAO_BASE_URL = 'https://custom.ark/api/v3'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    )
    await doubaoChat([{ role: 'user', content: 'hi' }])
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://custom.ark/api/v3/chat/completions')
  })

  it('throws on non-2xx so the fast path can fall back', async () => {
    process.env.DOUBAO_API_KEY = 'sk-ark'
    process.env.DOUBAO_MODEL = 'm'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'InvalidEndpointOrModel.NotFound' } }), { status: 404 }),
    )
    await expect(doubaoChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Doubao API 404/)
  })

  it('throws when unconfigured', async () => {
    delete process.env.DOUBAO_API_KEY; delete process.env.DOUBAO_MODEL
    await expect(doubaoChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/not configured/)
  })
})
