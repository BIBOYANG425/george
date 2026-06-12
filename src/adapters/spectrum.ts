// src/adapters/spectrum.ts
// Spectrum transport adapter. Owns the inbound loop, last-N dedup, text routing
// to the unchanged downstream pipeline, the Find My location path, and outbound
// replies via the conversation space. The ONLY file aware of Spectrum.
//
// Header last reviewed: 2026-06-11

import path from 'node:path'
import type { SpectrumClient, ReplyHandle } from './spectrum-client.js'
import type { SpectrumCredentials } from './spectrum-client.js'
import { createSpectrumClient } from './spectrum-client.js'
import { log } from '../observability/logger.js'
import { runOrchestrator } from '../agent/orchestrator.js'
import { supabase } from '../db/client.js'
import { extractCodeFromStartMessage, runHandshake } from '../onboarding/handshake.js'
import { lookupByCode, linkImessageHandle } from '../onboarding/pending-users.js'
import { checkInjection, INJECTION_REJECTIONS } from '../security/injection-filter.js'
import { normalizeHandle } from '../services/phone-handle.js'
import { tryHandleUserCommand } from '../index.js'

export interface SpectrumHandlers {
  // Returns the reply text, or null to send nothing (filtered/handshake-consumed).
  handleText: (userId: string, text: string, reply: ReplyHandle) => Promise<string | null>
  // Fire-and-forget: refresh the user's location into LocationContext.
  handleLocation: (userId: string) => Promise<void>
}

const DEDUP_CAP = 2000

export interface LoopOptions { debounceMs?: number }

export async function runSpectrumLoop(
  client: SpectrumClient,
  handlers: SpectrumHandlers,
  opts: LoopOptions = {},
): Promise<void> {
  const debounceMs = opts.debounceMs ?? 1500
  const seen = new Set<string>()
  const buffers = new Map<string, { texts: string[]; reply: ReplyHandle; timer: ReturnType<typeof setTimeout> }>()

  const flush = async (senderId: string) => {
    const buf = buffers.get(senderId)
    if (!buf) return
    buffers.delete(senderId)
    // Show the "…" typing bubble while the (slow) orchestrator turn runs.
    // Best-effort: a failed typing signal must never block or fail the reply.
    await buf.reply.startTyping().catch(() => {})
    try {
      const out = await handlers.handleText(senderId, buf.texts.join('\n'), buf.reply)
      if (out) await buf.reply.sendText(out)
    } catch (err) {
      log('error', 'spectrum_turn_error', { senderId, error: (err as Error).message })
    } finally {
      await buf.reply.stopTyping().catch(() => {})
    }
  }

  for await (const [reply, message] of client.messages()) {
    if (message.messageId) {
      if (seen.has(message.messageId)) continue
      seen.add(message.messageId)
      if (seen.size > DEDUP_CAP) for (const id of Array.from(seen).slice(0, DEDUP_CAP / 2)) seen.delete(id)
    }
    if (message.contentType !== 'text') continue
    const existing = buffers.get(message.senderId)
    if (existing) {
      existing.texts.push(message.text)
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => void flush(message.senderId), debounceMs)
    } else {
      // All messages in a per-sender burst share one conversation; the first
      // message's reply handle is representative for the coalesced turn.
      const entry = { texts: [message.text], reply, timer: setTimeout(() => void flush(message.senderId), debounceMs) }
      buffers.set(message.senderId, entry)
    }
  }
  // Drain any pending buffers when the stream ends.
  await Promise.all(Array.from(buffers.keys()).map(flush))
}

export interface TextHandlerDeps {
  checkInjection: (text: string) => { blocked: boolean; reason?: string }
  pickRejection: () => string
  // Returns true if the handshake consumed the message (send nothing further).
  tryHandshake: (userId: string, text: string, reply: ReplyHandle) => Promise<boolean>
  // Returns a command reply string, or null if not a command.
  tryUserCommand: (userId: string, text: string) => Promise<string | null>
  // Runs the orchestrator and returns the final reply text (or '').
  runOrchestratorText: (userId: string, text: string) => Promise<string>
  normalizeHandle: (raw: string) => string
}

export function buildTextHandler(deps: TextHandlerDeps) {
  return async (rawUserId: string, text: string, reply: ReplyHandle): Promise<string | null> => {
    const userId = deps.normalizeHandle(rawUserId)
    if (deps.checkInjection(text).blocked) return deps.pickRejection()
    if (await deps.tryHandshake(userId, text, reply)) return null
    const cmd = await deps.tryUserCommand(userId, text)
    if (cmd !== null) return cmd
    const out = await deps.runOrchestratorText(userId, text)
    return out || null
  }
}

// startSpectrumAdapter wires the real spectrum-ts SDK behind the seam and
// drives the downstream pipeline (injection filter → handshake → user commands
// → orchestrator). Mirrors startIMessageAdapter from adapters/imessage.ts but
// without the Mac-only polling loop — Spectrum pushes inbound via app.messages.
export async function startSpectrumAdapter(creds: SpectrumCredentials): Promise<void> {
  const client = await createSpectrumClient(creds)

  const handleText = buildTextHandler({
    checkInjection,
    pickRejection: () => INJECTION_REJECTIONS[Math.floor(Math.random() * INJECTION_REJECTIONS.length)],

    tryHandshake: async (userId: string, text: string, reply: ReplyHandle): Promise<boolean> => {
      const parsed = extractCodeFromStartMessage(text)
      if (!parsed) return false
      return runHandshake({
        code: parsed.code,
        format: parsed.format,
        imessageHandle: userId,
        sendImessage: async (out) => {
          if (out.text) await reply.sendText(out.text)
          for (const p of out.imagePaths ?? []) await reply.sendAttachment(path.resolve(p))
          for (const f of out.filePaths ?? []) await reply.sendAttachment(path.resolve(f))
        },
        lookupPending: (c) => lookupByCode(supabase, c),
        linkImessageHandle: (c, h) => linkImessageHandle(supabase, c, h),
        profileUrlBase: process.env.ONBOARDING_PROFILE_URL_BASE ?? 'https://uscbia.com/george/profile',
      })
    },

    tryUserCommand: (userId: string, text: string) => tryHandleUserCommand(userId, text),

    runOrchestratorText: async (userId: string, text: string): Promise<string> => {
      let finalText = ''
      for await (const event of runOrchestrator({
        userId,
        channel: 'imessage',
        text,
      })) {
        const e = event as {
          type?: string
          result?: string
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
          finalText = e.result
        } else if (e.type === 'assistant' && e.message?.content && finalText === '') {
          const t = e.message.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('')
          if (t) finalText = t
        }
      }
      return finalText
    },

    normalizeHandle,
  })

  // Phase 2: getLocation returns null, so handleLocation is a no-op.
  const handleLocation = async (_userId: string): Promise<void> => {}

  await runSpectrumLoop(client, { handleText, handleLocation })
}
