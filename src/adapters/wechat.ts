// WeChat Official Account adapter. POST /wechat receives XML → signature verify →
// parse → dedup (60s window) → runOrchestrator(). Access token cached with lazy refresh.
// Non-text messages (voice, image, video, location) return a playful inline refusal.
// Non-null responses are split on blank-line boundaries into up to 4 chat messages with
// INTER_MESSAGE_DELAY_MS between parts, matching WeChat's short-burst cadence.
// Subscribe events trigger the BIA welcome copy.
// Outbound custom/send treats a non-zero WeChat errcode (HTTP 200) as a failure
// and throws, so callers (e.g. the shipping notifier) don't mark undelivered
// messages as 'sent'.
//
// Header last reviewed: 2026-06-23

import { Router } from 'express'
import { config } from '../config.js'
import { parseIncomingXml, verifySignature, splitMessage } from './wechat-xml.js'
import { runOrchestrator } from '../agent/orchestrator.js'
import { log } from '../observability/logger.js'
import { splitIntoMessages, sleep, INTER_MESSAGE_DELAY_MS } from './split-response.js'
import { assertWeChatSendOk } from './wechat-send-result.js'
import type { IncomingMessage } from './types.js'

const NON_TEXT_RESPONSES: Record<string, string> = {
  voice: '语音我这边暂时没法听，打字发过来。',
  image: '图片我这边读不了，用文字描述一下内容？',
  video: '视频我这边读不了，用文字说一下你想问什么？',
  location: '定位我这边读不了，直接说地名或者想问什么。',
  sticker: '表情包看到了 —— 你想说啥？',
  link: '链接我这边打不开，贴里面的文字或者直接说你想问什么。',
}

let cachedToken = { token: '', expiresAt: 0 }

async function getAccessToken(): Promise<string> {
  if (Date.now() < cachedToken.expiresAt) return cachedToken.token
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wechat.appId}&secret=${config.wechat.appSecret}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const data = (await res.json()) as { access_token: string; expires_in: number }
  if (!data.access_token) {
    log('error', 'wechat_token_error', { response: data })
    throw new Error('Failed to get WeChat access token')
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  }
  return cachedToken.token
}

async function sendCustomerServiceMessage(openId: string, text: string) {
  const token = await getAccessToken()
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: openId,
        msgtype: 'text',
        text: { content: text },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  // WeChat returns HTTP 200 with {errcode, errmsg} even on failure (see
  // wechat-send-result.ts). Read the body once, then fail on a transport error
  // OR a non-zero errcode so callers don't mark undelivered messages 'sent'.
  const bodyText = await res.text()
  let errcode: number | undefined
  let errmsg: string | undefined
  try {
    const parsed = JSON.parse(bodyText) as { errcode?: number; errmsg?: string }
    errcode = parsed.errcode
    errmsg = parsed.errmsg
  } catch {
    // non-JSON body — leave errcode undefined; res.ok still gates transport
  }
  if (!res.ok || (typeof errcode === 'number' && errcode !== 0)) {
    log('error', 'wechat_send_error', { openId, status: res.status, errcode, errmsg })
  }
  assertWeChatSendOk({ ok: res.ok, status: res.status, errcode, errmsg })
}

async function sendResponse(openId: string, text: string) {
  const parts = splitMessage(text)
  for (const part of parts) {
    await sendCustomerServiceMessage(openId, part)
    if (parts.length > 1) await new Promise((r) => setTimeout(r, 200))
  }
}

const processedMessages = new Map<string, number>()

setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [key, time] of processedMessages) {
    if (time < cutoff) processedMessages.delete(key)
  }
}, 30_000)

function isDuplicate(msgId: string): boolean {
  if (processedMessages.has(msgId)) return true
  processedMessages.set(msgId, Date.now())
  return false
}

export function createWeChatRouter(): Router {
  const router = Router()

  router.get('/wechat', (req, res) => {
    const { signature, timestamp, nonce, echostr } = req.query as Record<string, string>
    if (verifySignature(signature, timestamp, nonce, config.wechat.token)) {
      res.send(echostr)
    } else {
      res.status(403).send('Invalid signature')
    }
  })

  router.post('/wechat', async (req, res) => {
    const { signature, timestamp, nonce } = req.query as Record<string, string>
    if (!verifySignature(signature, timestamp, nonce, config.wechat.token)) {
      return res.status(403).send('Invalid signature')
    }

    try {
      const msg = await parseIncomingXml(req.body as string)

      if (msg.msgType === 'event' && msg.event === 'subscribe') {
        res.send('success')
        await sendCustomerServiceMessage(
          msg.fromUser,
          '我是 George，BIA (Bridging Internationals Association) 的 AI 伙伴 —— 3,500+ USC 国际学生社群。\n\n找活动、选课、sublet、认识人、campus 攻略都可以问我。直接发消息就行。',
        )
        return
      }

      if (msg.msgId && isDuplicate(msg.msgId)) {
        return res.send('success')
      }

      res.send('success')

      // Non-text message types get an inline refusal; no LLM call needed.
      if (msg.msgType && msg.msgType !== 'text') {
        const refusal = NON_TEXT_RESPONSES[msg.msgType] || NON_TEXT_RESPONSES.sticker
        await sendResponse(msg.fromUser, refusal)
        return
      }

      const text = msg.content || ''
      if (!text) return

      const collectedText: string[] = []
      for await (const event of runOrchestrator({
        userId: msg.fromUser,
        channel: 'web',
        text,
      })) {
        if (event.type === 'text' && event.text) {
          collectedText.push(event.text)
        }
      }
      const response = collectedText.join('')

      if (response) {
        const parts = splitIntoMessages(response)
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await sleep(INTER_MESSAGE_DELAY_MS)
          await sendResponse(msg.fromUser, parts[i])
        }
      }
    } catch (err) {
      log('error', 'wechat_handler_error', { error: (err as Error).message })
    }
  })

  return router
}

export { sendResponse as sendWeChatMessage }
