// src/adapters/spectrum.ts
// Spectrum transport adapter. Owns the inbound loop, last-N dedup, text routing
// to the unchanged downstream pipeline, the Find My location path, and outbound
// replies via the conversation space. The ONLY file aware of Spectrum.
//
// Header last reviewed: 2026-06-13

import path from 'node:path'
import type { SpectrumClient, ReplyHandle } from './spectrum-client.js'
import type { SpectrumCredentials } from './spectrum-client.js'
import { createSpectrumClient } from './spectrum-client.js'
import {
  recordSpectrumConnect,
  recordSpectrumInbound,
  recordSpectrumError,
  recordSpectrumReconnecting,
} from './spectrum-stats.js'
import { splitIntoMessages, sleep, INTER_MESSAGE_DELAY_MS } from './split-response.js'
import { log } from '../observability/logger.js'
import { runOrchestrator } from '../agent/orchestrator.js'
import { captureFactsFromTurn } from '../memory/capture.js'
import { supabase } from '../db/client.js'
import { extractCodeFromStartMessage, runHandshake } from '../onboarding/handshake.js'
import { lookupByCode, linkImessageHandle, lookupByImessageHandle, markGreeted } from '../onboarding/pending-users.js'
import { checkInjection, INJECTION_REJECTIONS } from '../security/injection-filter.js'
import { normalizeHandle } from '../services/phone-handle.js'
import { tryHandleUserCommand } from '../agent/user-command-router.js'
import { tryPingsCommand } from '../tools/pings-command.js'
import type { SessionStore } from '../agent/session-store.js'
import type { ProfileStore } from '../memory/profile.js'

// Conversation memory deps, injected from index.ts (where the singletons live).
// Without a sessionStore the orchestrator has no history and george treats
// every message in isolation — these wire the same persistence /chat uses.
export interface SpectrumAdapterDeps {
  sessionStore?: SessionStore
  profileStore?: ProfileStore
}

export interface SpectrumHandlers {
  // Returns the reply text, or null to send nothing (filtered/handshake-consumed).
  handleText: (userId: string, text: string, reply: ReplyHandle, abortController?: AbortController) => Promise<string | null>
  // Fire-and-forget: refresh the user's location into LocationContext.
  handleLocation: (userId: string) => Promise<void>
}

const DEDUP_CAP = 2000

// Sent once if the orchestrator turn runs long (e.g. the course recommender
// agent ~30s), so the user knows george is working rather than dead. Short,
// in-voice. The real reply follows when ready.
const STILL_THINKING = ['等我一下哈，还在翻 🔍', 'gimme a sec, still digging on this', '稍等，马上给你']
const pickStillThinking = (): string =>
  STILL_THINKING[Math.floor(Math.random() * STILL_THINKING.length)]

export interface LoopOptions {
  debounceMs?: number
  // Send a "still thinking" nudge if the turn exceeds this. Default 9s.
  interimDelayMs?: number
}

export async function runSpectrumLoop(
  client: SpectrumClient,
  handlers: SpectrumHandlers,
  opts: LoopOptions = {},
): Promise<void> {
  const debounceMs = opts.debounceMs ?? 1500
  const interimDelayMs = opts.interimDelayMs ?? 9000
  const seen = new Set<string>()
  const buffers = new Map<string, { texts: string[]; reply: ReplyHandle; timer: ReturnType<typeof setTimeout> }>()
  // The turn currently running for each sender. When the user fires another
  // message mid-turn, the message loop aborts this controller so we never reply
  // to a superseded message — the next turn handles the latest intent (the prior
  // message is already persisted to history). Keeps replies fast: no debounce
  // bump, just cancel-and-replace on a rapid follow-up.
  const inflight = new Map<string, AbortController>()

  const flush = async (senderId: string) => {
    const buf = buffers.get(senderId)
    if (!buf) return
    buffers.delete(senderId)
    const ac = new AbortController()
    inflight.set(senderId, ac)
    // Show the "…" typing bubble while the (slow) orchestrator turn runs.
    // Best-effort: a failed typing signal must never block or fail the reply.
    await buf.reply.startTyping().catch(() => {})
    // If the turn runs long, send one "still thinking" nudge so the user isn't
    // left staring at a typing bubble. Skipped if the turn was already superseded.
    const interimTimer = setTimeout(() => {
      if (!ac.signal.aborted) void buf.reply.sendText(pickStillThinking()).catch(() => {})
    }, interimDelayMs)
    try {
      const out = await handlers.handleText(senderId, buf.texts.join('\n'), buf.reply, ac)
      clearTimeout(interimTimer)
      // One idea per bubble: split on blank-line boundaries and send each as a
      // separate iMessage with a pause, matching george's short-burst cadence
      // (same as the legacy adapter). A single-paragraph reply stays one bubble.
      // Suppress the send entirely if a rapid follow-up superseded this turn.
      if (out && !ac.signal.aborted) {
        const parts = splitIntoMessages(out)
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await sleep(INTER_MESSAGE_DELAY_MS)
          await buf.reply.sendText(parts[i])
        }
      }
    } catch (err) {
      // A superseded turn aborts on purpose — that's not an error and it sends
      // nothing. Only a genuine failure is logged.
      if (!ac.signal.aborted) log('error', 'spectrum_turn_error', { senderId, error: (err as Error).message })
    } finally {
      clearTimeout(interimTimer)
      if (inflight.get(senderId) === ac) inflight.delete(senderId)
      await buf.reply.stopTyping().catch(() => {})
    }
  }

  for await (const [reply, message] of client.messages()) {
    recordSpectrumInbound()
    if (message.messageId) {
      if (seen.has(message.messageId)) continue
      seen.add(message.messageId)
      if (seen.size > DEDUP_CAP) for (const id of Array.from(seen).slice(0, DEDUP_CAP / 2)) seen.delete(id)
    }
    if (message.contentType !== 'text') continue
    // Rapid-fire supersede: a fresh message means the user is still talking, so
    // any turn already running for them is now stale — abort it so we don't reply
    // to a superseded message. (The coalesce path below batches messages that
    // arrive before a turn starts; this handles the ones that land mid-turn.)
    const running = inflight.get(message.senderId)
    if (running && !running.signal.aborted) running.abort()
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
  runOrchestratorText: (userId: string, text: string, abortController?: AbortController) => Promise<string>
  normalizeHandle: (raw: string) => string
}

export function buildTextHandler(deps: TextHandlerDeps) {
  return async (rawUserId: string, text: string, reply: ReplyHandle, abortController?: AbortController): Promise<string | null> => {
    const userId = deps.normalizeHandle(rawUserId)
    if (deps.checkInjection(text).blocked) return deps.pickRejection()
    if (await deps.tryHandshake(userId, text, reply)) return null
    const cmd = await deps.tryUserCommand(userId, text)
    if (cmd !== null) return cmd
    const out = await deps.runOrchestratorText(userId, text, abortController)
    return out || null
  }
}

// Build the downstream pipeline handlers (injection → handshake → user
// commands → orchestrator). Pure of any connection — reused across reconnects.
function buildSpectrumHandlers(deps: SpectrumAdapterDeps): SpectrumHandlers {
  const handleText = buildTextHandler({
    checkInjection,
    pickRejection: () => INJECTION_REJECTIONS[Math.floor(Math.random() * INJECTION_REJECTIONS.length)],

    tryHandshake: async (userId: string, text: string, reply: ReplyHandle): Promise<boolean> => {
      const send = async (out: { text?: string; imagePaths?: string[]; filePaths?: string[] }) => {
        if (out.text) await reply.sendText(out.text)
        for (const p of out.imagePaths ?? []) await reply.sendAttachment(path.resolve(p))
        for (const f of out.filePaths ?? []) await reply.sendAttachment(path.resolve(f))
      }
      const common = {
        imessageHandle: userId,
        sendImessage: send,
        lookupPending: (c: string) => lookupByCode(supabase, c),
        linkImessageHandle: (c: string, h: string) => linkImessageHandle(supabase, c, h),
        profileUrlBase: process.env.ONBOARDING_PROFILE_URL_BASE ?? 'https://uscbia.com/george/profile',
        markGreeted: (c: string) => markGreeted(supabase, c),
      }

      const parsed = extractCodeFromStartMessage(text)
      if (parsed) {
        const handled = await runHandshake({ code: parsed.code, format: parsed.format, ...common })
        if (handled) log('info', 'onboarding_handshake', { via: 'code', format: parsed.format })
        return handled
      }

      // Spectrum signup funnel: the web form registers the student's phone and
      // pre-links it to a pending row, then prefills just "Hi". Greet known
      // pending handles that haven't been greeted yet; everything else falls
      // through to the orchestrator. format:'natural' so a race-miss is silent.
      const byHandle = await lookupByImessageHandle(supabase, userId)
      if (byHandle && !byHandle.greeted_at) {
        const handled = await runHandshake({ code: byHandle.code, format: 'natural', ...common })
        if (handled) log('info', 'onboarding_handshake', { via: 'handle', code: byHandle.code })
        return handled
      }
      return false
    },

    tryUserCommand: async (userId: string, text: string) => {
      const pingsReply = await tryPingsCommand(userId, text)
      if (pingsReply !== null) return pingsReply
      return tryHandleUserCommand(userId, text)
    },

    runOrchestratorText: async (userId: string, text: string, abortController?: AbortController): Promise<string> => {
      const turnStart = Date.now()
      // Persist the user turn before running so it survives an orchestrator
      // failure, then run WITH the session + profile stores so george loads
      // prior conversation context (buildHistoryPrefix). Mirrors POST /chat.
      if (deps.sessionStore) {
        await deps.sessionStore.save(userId, {
          sessionId: userId,
          messages: [{ role: 'user', content: text }],
          systemContext: {},
        })
      }
      let finalText = ''
      let turnTelemetry: import('../agent/session-store.js').TurnTelemetry | undefined
      for await (const event of runOrchestrator({
        userId,
        channel: 'imessage',
        text,
        sessionStore: deps.sessionStore,
        profileStore: deps.profileStore,
        abortController,
      })) {
        const e = event as {
          type?: string
          result?: string
          telemetry?: import('../agent/session-store.js').TurnTelemetry
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        if (e.type === 'telemetry') {
          turnTelemetry = e.telemetry
        } else if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
          finalText = e.result
        } else if (e.type === 'assistant' && e.message?.content && finalText === '') {
          const t = e.message.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('')
          if (t) finalText = t
        }
      }
      // Persist the assistant turn (with per-turn telemetry) so the dashboard
      // captures cost/tokens/model for the production iMessage path too.
      if (deps.sessionStore && finalText) {
        await deps.sessionStore.save(userId, {
          sessionId: userId,
          messages: [{ role: 'assistant', content: finalText, telemetry: turnTelemetry }],
          systemContext: {},
        })
      }
      // Fire-and-forget per-turn memory capture (no-op unless MEMORY_CAPTURE_ENABLED).
      // Spectrum is the production iMessage path and bypasses the index.ts routes, so
      // capture has to be wired here too (codex review P2).
      if (deps.profileStore && finalText) {
        void captureFactsFromTurn(deps.profileStore, userId, text, finalText)
      }
      log('info', 'spectrum_turn', {
        ms: Date.now() - turnStart,
        replied: finalText.length > 0,
        chars: finalText.length,
      })
      return finalText
    },

    normalizeHandle,
  })

  // Phase 2: getLocation returns null, so handleLocation is a no-op.
  const handleLocation = async (_userId: string): Promise<void> => {}

  return { handleText, handleLocation }
}

// ── Connection lifecycle: clean shutdown + auto-reconnect ──────────────
// Each Spectrum connection must be closed on shutdown, else it dangles on
// Photon's side and the shared-pool routing sends inbound to a dead socket.
// And a dropped stream must reconnect, else george goes silently deaf.
let spectrumStopping = false
let activeSpectrumClient: SpectrumClient | null = null

// startSpectrumAdapter connects to Spectrum and drives the downstream pipeline.
// Runs until stopSpectrumAdapter() is called: if the message stream ends or
// throws (transient drop), it reconnects with exponential backoff. Mirrors
// startIMessageAdapter but for Spectrum's pushed app.messages stream.
export async function startSpectrumAdapter(
  creds: SpectrumCredentials,
  deps: SpectrumAdapterDeps = {},
): Promise<void> {
  spectrumStopping = false
  const handlers = buildSpectrumHandlers(deps)
  let backoffMs = 1_000

  while (!spectrumStopping) {
    try {
      const client = await createSpectrumClient(creds)
      activeSpectrumClient = client
      backoffMs = 1_000 // reset after a successful connect
      log('info', 'spectrum_connected', {})
      recordSpectrumConnect()
      await runSpectrumLoop(client, handlers)
      // runSpectrumLoop returning means the stream ended (not an error).
      log('warn', 'spectrum_stream_ended', {})
    } catch (err) {
      log('error', 'spectrum_stream_error', { error: (err as Error).message })
      recordSpectrumError((err as Error).message)
    } finally {
      if (activeSpectrumClient) {
        await activeSpectrumClient.close().catch(() => {})
        activeSpectrumClient = null
      }
    }
    if (spectrumStopping) break
    await new Promise((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, 30_000)
    log('warn', 'spectrum_reconnecting', { backoffMs })
    recordSpectrumReconnecting()
  }
  log('info', 'spectrum_adapter_stopped', {})
}

// Close the live Spectrum connection cleanly and stop the reconnect loop.
// Called from the process shutdown handler so a restart never orphans a
// connection on Photon's side.
export async function stopSpectrumAdapter(): Promise<void> {
  spectrumStopping = true
  const client = activeSpectrumClient
  activeSpectrumClient = null
  if (client) await client.close().catch(() => {})
}

// Expose the live connection to out-of-band senders (e.g. squad-ping fan-out).
// Returns null if the Spectrum adapter is not running or currently reconnecting.
export function getActiveSpectrumClient(): SpectrumClient | null {
  return activeSpectrumClient
}
