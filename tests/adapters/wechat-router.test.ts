// tests/adapters/wechat-router.test.ts
// HTTP-level coverage for the WeChat webhook router (src/adapters/wechat.ts):
//   1. fail-closed 403 when WECHAT_TOKEN is unconfigured — BEFORE signature
//      verification (an empty token is attacker-forgeable), so even a signature
//      that would "verify" against the empty token is rejected.
//   2. a duplicate subscribe event (same MsgId) is suppressed — the welcome copy
//      is sent exactly once, proving subscribe handling now runs AFTER msgId dedup.
//
// No supertest in the tree: we boot the real router on an ephemeral port and issue
// requests via node:http, and stub global.fetch ONLY for the WeChat outbound send
// (issuing test requests over http keeps them clear of the fetch stub).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import express from 'express'
import { createWeChatRouter } from '../../src/adapters/wechat.js'
import { config } from '../../src/config.js'

let server: http.Server
let port: number
const originalToken = config.wechat.token

function sign(token: string, timestamp: string, nonce: string): string {
  return crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
}

function postXml(path: string, xml: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'text/xml' } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    req.write(xml)
    req.end()
  })
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  const app = express()
  app.use(express.text({ type: 'text/xml' }))
  app.use(createWeChatRouter())
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  config.wechat.token = originalToken
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  config.wechat.token = originalToken
  vi.unstubAllGlobals()
})

describe('POST /wechat — fail closed on unconfigured token', () => {
  it('returns 403 even for a signature that would verify against the empty token', async () => {
    config.wechat.token = ''
    const ts = '1700000000'
    const nonce = 'abc'
    // A signature computed for the EMPTY token — it would pass verifySignature if
    // the guard did not run first. The 403 must be the token-guard 403, not the
    // signature 403.
    const forged = sign('', ts, nonce)
    const res = await postXml(
      `/wechat?signature=${forged}&timestamp=${ts}&nonce=${nonce}`,
      '<xml><FromUserName><![CDATA[u1]]></FromUserName></xml>',
    )
    expect(res.status).toBe(403)
    expect(res.body).toContain('not configured')
  })
})

describe('POST /wechat — duplicate subscribe suppressed', () => {
  beforeEach(() => {
    config.wechat.token = 'test-token-123'
  })

  it('sends the welcome exactly once when the same subscribe MsgId arrives twice', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        calls.push(u)
        if (u.includes('/cgi-bin/token')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
        }
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }),
    )

    const ts = '1700000001'
    const nonce = 'xyz'
    const sig = sign('test-token-123', ts, nonce)
    const msgId = '900000001' // unique per test; subscribe events carrying a MsgId dedup like any message
    const xml =
      `<xml><ToUserName><![CDATA[gh_test]]></ToUserName>` +
      `<FromUserName><![CDATA[oSubscriber]]></FromUserName>` +
      `<CreateTime>${ts}</CreateTime>` +
      `<MsgType><![CDATA[event]]></MsgType>` +
      `<Event><![CDATA[subscribe]]></Event>` +
      `<MsgId>${msgId}</MsgId></xml>`
    const q = `signature=${sig}&timestamp=${ts}&nonce=${nonce}`

    const first = await postXml(`/wechat?${q}`, xml)
    expect(first.status).toBe(200)
    expect(first.body).toBe('success')
    // The welcome send fires after res.send('success'); wait for it to land.
    await waitFor(() => calls.some((u) => u.includes('/message/custom/send')))

    const second = await postXml(`/wechat?${q}`, xml)
    expect(second.status).toBe(200)
    expect(second.body).toBe('success')
    // Give any (incorrect) second send a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 50))

    const sends = calls.filter((u) => u.includes('/message/custom/send'))
    expect(sends).toHaveLength(1)
  })
})
