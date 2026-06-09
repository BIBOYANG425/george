// iMessage adapter (macOS only, via @photon-ai/imessage-kit). Two modes:
//
// 1. LOCAL mode (config.backendRelayUrl unset): the adapter reads new iMessages
//    via Photon SDK and calls runOrchestrator() in-process. The full agent loop
//    (orchestrator + sub-agents via Agent SDK, tools, Supabase, Anthropic) runs
//    on this host. Used when the whole George stack is colocated on one Mac.
//
// 2. BRIDGE mode (config.backendRelayUrl set): the adapter reads new iMessages
//    locally but forwards them over HTTPS to a remote backend (e.g. the
//    Cloudflare Container) and sends the response back via Photon SDK.
//    Anthropic / Supabase / Maps calls never happen on this host. Used when
//    the agent loop lives outside China (Container) but iMessage still needs
//    a real Mac for the Photon SDK to work.
//
// Both modes require macOS + Full Disk Access + signed-in iMessage. If the
// SDK fails to init, logs a warning and continues — WeChat-only mode still works.
// On bridge startup we ping the backend's /health once and log relay_ok /
// relay_unauthorized / relay_unreachable so config errors surface immediately
// instead of failing silently on the first incoming message.
//
// Header last reviewed: 2026-06-07

// IMessageSDK is type-only at module load so the package's native binding
// never gets required on Linux. The runtime instance is dynamic-imported
// inside startIMessageAdapter() after the platform === 'darwin' guard.
import type { IMessageSDK as IMessageSDKType } from '@photon-ai/imessage-kit'
import { config } from '../config.js'
import { runOrchestrator } from '../agent/orchestrator.js'
import { log } from '../observability/logger.js'
import { splitIntoMessages, sleep, INTER_MESSAGE_DELAY_MS } from './split-response.js'
import type { IncomingMessage } from './types.js'
import { supabase } from '../db/client.js'
import { extractCodeFromStartMessage, runHandshake } from '../onboarding/handshake.js'
import { lookupByCode, linkImessageHandle } from '../onboarding/pending-users.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function cleanupImessageTempFiles(): Promise<void> {
  try {
    const dir = path.join(os.homedir(), 'Pictures')
    const entries = await fs.readdir(dir)
    await Promise.all(
      entries
        .filter((e) => e.startsWith('imsg_temp_'))
        .map((e) => fs.unlink(path.join(dir, e)).catch(() => undefined)),
    )
  } catch {
    // Pictures dir unreadable — nothing to clean. Continue.
  }
}

let sdk: IMessageSDKType | null = null

const BRIDGE_TIMEOUT_MS = 45_000
const RELAY_FALLBACK_MSG = '我这边联系不上服务器，几分钟后再试 🥲'
const RELAY_GENERIC_ERROR_MSG = '刚卡了一下，再试一次。'

async function pingBackendRelay() {
  const url = config.backendRelayUrl
  if (!url) return
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8_000) })
    if (res.ok) {
      log('info', 'relay_ok', { url })
    } else if (res.status === 401 || res.status === 403) {
      log('error', 'relay_unauthorized', { url, status: res.status })
    } else {
      log('warn', 'relay_unhealthy', { url, status: res.status })
    }
  } catch (err) {
    log('error', 'relay_unreachable', { url, error: (err as Error).message })
  }
}

async function forwardToBackend(incoming: IncomingMessage): Promise<string | null> {
  const url = config.backendRelayUrl
  if (!url) throw new Error('backendRelayUrl not configured')

  let res: Response
  try {
    res = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.adminToken}`,
      },
      body: JSON.stringify({
        userId: incoming.userId,
        platform: incoming.platform,
        text: incoming.text,
      }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    })
  } catch (err) {
    log('error', 'relay_unreachable', { error: (err as Error).message })
    return RELAY_FALLBACK_MSG
  }

  if (res.status === 401 || res.status === 403) {
    log('error', 'relay_401', { status: res.status })
    return RELAY_FALLBACK_MSG
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    log('error', 'relay_5xx', { status: res.status, body: text.slice(0, 200) })
    return RELAY_FALLBACK_MSG
  }
  const data = (await res.json().catch(() => ({}))) as {
    response?: string | null
    error?: string
  }
  // Distinguish three cases:
  //   data.response === null  → backend filtered the message (automated-message
  //                             noise, meeting invite, etc). Propagate null so
  //                             onDirectMessage drops it silently, matching
  //                             local-mode behavior. NO reply sent.
  //   data.response missing or empty string → backend responded but didn't
  //                             produce a reply we can use. Treat as a
  //                             relay-side hiccup and show the fallback.
  //   data.response is a non-empty string → real reply, send it through.
  if (data.response === null) return null
  if (!data.response || !data.response.trim()) {
    log('warn', 'relay_empty_response', {})
    return RELAY_FALLBACK_MSG
  }
  return data.response
}

export async function startIMessageAdapter() {
  if (!config.imessage.enabled) {
    log('warn', 'imessage_skip', { reason: 'IMESSAGE_ENABLED not set' })
    return
  }
  if (process.platform !== 'darwin') {
    log('warn', 'imessage_skip', { reason: `unsupported platform ${process.platform} — macOS only` })
    return
  }

  // Bridge-mode diagnostics: ping the backend once at startup and warn about
  // unused secrets that suggest the operator misconfigured the .env.
  if (config.backendRelayUrl) {
    log('info', 'bridge_mode_active', { backendRelayUrl: config.backendRelayUrl })
    if (config.anthropic.apiKey) {
      log('warn', 'bridge_unused_secrets', {
        message:
          'ANTHROPIC_API_KEY is set but this instance is in bridge mode and will never call Anthropic directly. Remove from the bridge .env to avoid leaking a key that has no purpose here.',
      })
    }
    await pingBackendRelay()
  }

  try {
    // Dynamic import so the native module isn't required on non-macOS.
    // The Container deploy runs on Linux with IMESSAGE_ENABLED=false and
    // never reaches this point; a top-level require would crash startup
    // because @photon-ai/imessage-kit binds to macOS frameworks.
    const { IMessageSDK } = await import('@photon-ai/imessage-kit')
    sdk = new IMessageSDK({ debug: true })

    // Custom polling loop replacing sdk.startWatching(). The SDK's built-in
    // watcher fails silently to detect new chat.db rows on this Mac (likely a
    // better-sqlite3 mmap caching issue with the persistent readonly handle).
    // sdk.getMessages() called fresh per tick does see new rows reliably, so
    // we drive our own poll and reuse the SDK only for queries + sends.
    const seenIds = new Set<string>()
    let lastPollAt = new Date(Date.now() - 10_000)
    const POLL_INTERVAL_MS = 2_000

    const handleMessage = async (msg: {
      id: string
      text: string | null
      sender: string | null
      isFromMe: boolean
      isReaction: boolean
      date: Date
    }) => {
      if (msg.isFromMe) return
      if (msg.isReaction) return
      if (!msg.text || !msg.sender) return

      const handshakeCode = extractCodeFromStartMessage(msg.text)
      if (handshakeCode) {
        try {
          await cleanupImessageTempFiles()
          await runHandshake({
            code: handshakeCode,
            imessageHandle: msg.sender,
            sendImessage: async (out) => {
              await sdk!.send(out.to, {
                text: out.text,
                images: out.imagePaths && out.imagePaths.length > 0 ? out.imagePaths : undefined,
                files: out.filePaths && out.filePaths.length > 0 ? out.filePaths : undefined,
              })
            },
            lookupPending: (code) => lookupByCode(supabase, code),
            linkImessageHandle: (code, h) => linkImessageHandle(supabase, code, h),
            profileUrlBase:
              process.env.ONBOARDING_PROFILE_URL_BASE ?? 'https://uscbia.com/george/profile',
          })
        } catch (err) {
          log('error', 'handshake_error', { error: (err as Error).message })
        }
        return
      }

      const incoming: IncomingMessage = {
        userId: msg.sender,
        platform: 'imessage',
        text: msg.text,
        msgType: 'text',
        timestamp: msg.date.getTime(),
      }

      try {
        let response: string | null
        if (config.backendRelayUrl) {
          response = await forwardToBackend(incoming)
        } else {
          const collectedText: string[] = []
          for await (const event of runOrchestrator({
            userId: incoming.userId,
            channel: 'imessage',
            text: incoming.text,
          })) {
            if (event.type === 'text' && event.text) {
              collectedText.push(event.text)
            }
          }
          response = collectedText.join('') || null
        }

        if (response !== null) {
          const parts = splitIntoMessages(response)
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) await sleep(INTER_MESSAGE_DELAY_MS)
            await sdk!.send(msg.sender, parts[i])
          }
        }
      } catch (err) {
        log('error', 'imessage_error', { error: (err as Error).message })
        await sdk!.send(msg.sender, RELAY_GENERIC_ERROR_MSG).catch(() => {})
      }
    }

    const pollLoop = setInterval(async () => {
      try {
        const since = new Date(lastPollAt.getTime() - 1_000)
        const result = await sdk!.getMessages({ since, excludeOwnMessages: true })
        lastPollAt = new Date()
        for (const msg of result.messages) {
          if (seenIds.has(msg.id)) continue
          seenIds.add(msg.id)
          await handleMessage(msg)
        }
        if (seenIds.size > 5_000) {
          const arr = Array.from(seenIds)
          seenIds.clear()
          for (const id of arr.slice(-2_500)) seenIds.add(id)
        }
      } catch (err) {
        log('error', 'imessage_poll_error', { error: (err as Error).message })
      }
    }, POLL_INTERVAL_MS)

    ;(globalThis as { __georgePollLoop?: ReturnType<typeof setInterval> }).__georgePollLoop = pollLoop

    log('info', 'imessage_connected', {})
  } catch (err) {
    log('warn', 'imessage_sdk_unavailable', { error: (err as Error).message })
    sdk = null
  }
}

export async function sendIMessage(recipient: string, text: string) {
  if (!sdk) throw new Error('iMessage SDK not connected')
  await sdk.send(recipient, text)
}

export async function stopIMessageAdapter() {
  if (sdk) {
    await sdk.close()
    sdk = null
  }
}
