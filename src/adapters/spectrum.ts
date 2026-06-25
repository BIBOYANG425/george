// src/adapters/spectrum.ts
// Spectrum transport adapter. Owns the inbound loop, last-N dedup, text routing
// to the unchanged downstream pipeline, the Find My location path, and outbound
// replies via the conversation space. The ONLY file aware of Spectrum.
//
// Also tracks the per-sender last-reply time in-process so a long silence
// followed by a fresh ping can hand the orchestrator a delay-context note
// (renderDelayContext) — injected as a per-turn system note, NOT as response
// delay. Default-off behind GEORGE_ACTIVITY_STATE_ENABLED ('' when unset).
//
// Pacing & Delivery v1 (default-OFF, GEORGE_PACING_ENABLED): when on, bubble 0 is
// sent inline and bubbles 1..N-1 are persisted to a durable outgoing scheduler,
// drained out-of-band by a restart-surviving drainer started once here; a fresh
// inbound cancels a sender's pending bubbles. OFF: byte-for-byte today's path.
//
// Header last reviewed: 2026-06-24

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
import { startSpectrumWatchdog, stopSpectrumWatchdog } from './spectrum-watchdog.js'
import { parseControlTokens, isNoReplyEnabled, getReadReceiptDelayMs } from './split-response.js'
import { stageReadReceiptDelay, stageGenerate, stageSend, stageSendPaced } from './spectrum-stages.js'
import {
  createOutgoingScheduler,
  startDrainer,
  startQueuePruner,
  type OutgoingScheduler,
} from './outgoing-scheduler.js'
import { createSupabaseOutgoingSchedulerDB } from '../db/outgoing-bubbles.js'
import { checkRateLimit } from './rate-limiter.js'
import { log } from '../observability/logger.js'
import { renderDelayContext } from '../agent/activity-state.js'
import { runOrchestrator } from '../agent/orchestrator.js'
import { captureFactsFromTurn } from '../memory/capture.js'
import { TURN_EVALUATORS, dispatchEvaluators } from '../agent/evaluators/registry.js'
import type { EvalContext } from '../agent/evaluators/types.js'
import { supabase } from '../db/client.js'
import { extractCodeFromStartMessage, runHandshake, resendOnboardLink, shouldRelink } from '../onboarding/handshake.js'
import { lookupByCode, linkImessageHandle, lookupByImessageHandle, markGreeted, markReminded } from '../onboarding/pending-users.js'
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
  // delayContext is an optional per-turn system note (e.g. "it's been ~9h since
  // your last reply") injected into the orchestrator prompt; '' / undefined when
  // there's nothing to add.
  handleText: (userId: string, text: string, reply: ReplyHandle, abortController?: AbortController, delayContext?: string) => Promise<string | null>
  // Fire-and-forget: refresh the user's location into LocationContext.
  handleLocation: (userId: string) => Promise<void>
}

const DEDUP_CAP = 2000

// Burst guard config (default-OFF, SPECTRUM_BURST_GUARD_ENABLED). Read at call
// time from env — mirrors the MEMORY_CAPTURE_ENABLED / GROUNDED_PROACTIVE
// precedent, so config.ts stays free of eager validation and tests toggle env
// directly. When disabled, the inbound loop and the user-row save are
// byte-for-byte today's behavior.
//
//   A layer (abuse): sustained volume → 5-10min quiet cooldown (one notice).
//   B layer (splitter): abort-then-refold so a split thought is answered once.
function readBurstConfig(): { enabled: boolean; perMin: number; strikes: number; cooldownMs: number; maxRefolds: number } {
  const int = (v: string | undefined, d: number) => {
    const n = parseInt(v ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  return {
    enabled: process.env.SPECTRUM_BURST_GUARD_ENABLED === 'true',
    perMin: int(process.env.SPECTRUM_BURST_PER_MIN, 30),
    strikes: int(process.env.SPECTRUM_BURST_STRIKES, 3),
    cooldownMs: Math.min(Math.max(int(process.env.SPECTRUM_COOLDOWN_MS, 300_000), 300_000), 600_000), // clamp 5-10min
    maxRefolds: int(process.env.SPECTRUM_MAX_REFOLDS, 3),
  }
}

// One in-voice line sent ONCE when a sender is put on cooldown for flooding, then
// silence for the window. Transport-level (not agent output), like
// RATE_LIMIT_RESPONSE. Short, 学长 register, one emoji.
const BURST_COOLDOWN_NOTICE = '学长这会儿有点接不过来了😮‍💨 你缓几分钟再来找我哈'

// Pacing & Delivery config (default-OFF, GEORGE_PACING_ENABLED). Read at call
// time from env — same precedent as readBurstConfig. OFF → no scheduler/drainer
// is created and the send path is byte-for-byte today's behavior. The drain
// interval is how often the drainer re-reads the durable queue for due bubbles.
function readPacingConfig(): { enabled: boolean; drainIntervalMs: number } {
  return {
    enabled: process.env.GEORGE_PACING_ENABLED === 'true',
    drainIntervalMs: Number(process.env.PACING_DRAIN_INTERVAL_MS) || 1000,
  }
}

export interface LoopOptions {
  debounceMs?: number
  // Send a "still thinking" nudge if the turn exceeds this. Default 9s.
  interimDelayMs?: number
  // Pacing & Delivery v1 (default-OFF). When pacingEnabled is true AND a
  // scheduler is supplied, bubble 0 is sent inline and bubbles 1..N-1 are
  // persisted to the durable scheduler (drained out-of-band). A fresh inbound
  // cancels a sender's pending bubbles. Both optional → the default-OFF send
  // path (stageSend) is unchanged and existing callers/tests still compile.
  scheduler?: Pick<OutgoingScheduler, 'schedule' | 'cancelPending'>
  pacingEnabled?: boolean
}

export async function runSpectrumLoop(
  client: SpectrumClient,
  handlers: SpectrumHandlers,
  opts: LoopOptions = {},
): Promise<void> {
  const debounceMs = opts.debounceMs ?? 1500
  const interimDelayMs = opts.interimDelayMs ?? 9000
  const seen = new Set<string>()
  const buffers = new Map<string, { texts: string[]; reply: ReplyHandle; timer: ReturnType<typeof setTimeout>; refolds: number }>()
  // The turn currently running for each sender. A fresh mid-turn message aborts
  // this controller so we never reply to a superseded message (Bobby's intent).
  // With the burst guard ON we ALSO carry the in-flight `texts` forward (refold)
  // so the superseded content is answered in the next turn, not dropped. `texts`
  // / `refolds` are unused on the OFF path.
  const inflight = new Map<string, { ac: AbortController; texts: string[]; refolds: number }>()
  // Wall-clock of George's last reply per sender, kept in-process so a long
  // silence followed by a fresh ping can hand the model delay context (see
  // renderDelayContext). Default-off: empty/no-op unless the activity-state flag
  // is on. In-memory only — a restart simply forgets the gap, which is fine.
  const lastReplyAt = new Map<string, number>()
  // Burst guard (default-OFF). Read once per connection; OFF → the loop + save
  // below are byte-for-byte today's behavior.
  const burst = readBurstConfig()
  // Per-sender cooldown state, only populated for senders who actually flood.
  const burstState = new Map<string, { cooldownUntil: number }>()
  // Evict idle per-sender state so a long-lived process doesn't leak a row per
  // sender ever seen (same hygiene as rate-limiter.ts's sweep). Cleared on exit.
  // Created ONLY when the guard is on, so the OFF path is byte-for-byte today
  // (no extra timer keeping the event loop busy).
  const sweep: ReturnType<typeof setInterval> | null = burst.enabled
    ? setInterval(() => {
        const now = Date.now()
        const idleCutoff = now - 60 * 60_000 // forget a sender's last-reply after 1h idle
        for (const [k, t] of lastReplyAt) if (t < idleCutoff) lastReplyAt.delete(k)
        for (const [k, b] of burstState) if (b.cooldownUntil <= now) burstState.delete(k)
      }, 10 * 60_000)
    : null

  const flush = async (senderId: string) => {
    const buf = buffers.get(senderId)
    if (!buf) return
    // Refold-cap path (ON only): a turn is still running because we chose NOT to
    // abort it (cap hit). Don't start a parallel turn — wait and re-check shortly.
    // OFF path never hits this (a mid-turn message always aborted the in-flight one).
    if (burst.enabled && inflight.has(senderId)) {
      buf.timer = setTimeout(() => void flush(senderId), debounceMs)
      return
    }
    buffers.delete(senderId)
    const ac = new AbortController()
    inflight.set(senderId, { ac, texts: buf.texts, refolds: buf.refolds })
    // If it's been a long time since George last replied to this sender, prepend
    // a small situational note so he CAN acknowledge the gap naturally. This is
    // pure context — no artificial delay is added; the reply still goes out fast.
    const prev = lastReplyAt.get(senderId)
    const delayContext = prev ? renderDelayContext(Date.now() - prev) : ''
    // Optional, default-OFF "reading" pause BEFORE generation (no-op when off).
    // Pre-generation only: this never delays an already-composed reply.
    await stageReadReceiptDelay({ readReceiptDelayMs: getReadReceiptDelayMs() })
    try {
      // stageGenerate owns startTyping + the long-turn "still thinking" nudge +
      // the handleText await + clearTimeout on success/throw. delayContext rides
      // into the orchestrator as a per-turn system note. Returns out | null.
      const out = await stageGenerate(senderId, buf.texts, buf.reply, ac, handlers.handleText, delayContext, { interimDelayMs })
      // One idea per bubble: split on blank-line boundaries and send each as a
      // separate iMessage with a pause, matching george's short-burst cadence
      // (same as the legacy adapter). A single-paragraph reply stays one bubble.
      // Suppress the send entirely if a rapid follow-up superseded this turn.
      if (out && !ac.signal.aborted) {
        // Output-format control: George may emit {{NO_REPLY}} to decline to reply
        // (pure ack / automated text). When GEORGE_NOREPLY_ENABLED is on, suppress
        // the send entirely; otherwise strip the token so it can never reach a
        // user. Default OFF: this branch is exactly the previous send loop over
        // splitIntoMessages(out), so behavior is byte-for-byte unchanged.
        let toSend: string | null = out
        if (isNoReplyEnabled()) {
          const { noReply, text } = parseControlTokens(out)
          toSend = noReply ? null : text
        }
        if (toSend) {
          // Record this reply's time so the next ping can measure the gap (P2).
          // Only on an actual send — a suppressed {{NO_REPLY}} is not a reply.
          lastReplyAt.set(senderId, Date.now())
          // Pacing ON (flag + scheduler present): bubble 0 inline, bubbles 1..N-1
          // persisted to the durable scheduler and drained out-of-band. OFF: the
          // existing in-process stageSend, byte-for-byte unchanged.
          if (opts.pacingEnabled && opts.scheduler) {
            await stageSendPaced(toSend, buf.reply, senderId, ac, { schedule: opts.scheduler.schedule })
          } else {
            await stageSend(toSend, buf.reply, ac)
          }
        }
      }
    } catch (err) {
      // A superseded turn aborts on purpose — that's not an error and it sends
      // nothing. Only a genuine failure is logged.
      if (!ac.signal.aborted) log('error', 'spectrum_turn_error', { senderId, error: (err as Error).message })
    } finally {
      if (inflight.get(senderId)?.ac === ac) inflight.delete(senderId)
      await buf.reply.stopTyping().catch(() => {})
    }
  }

  try {
    for await (const [reply, message] of client.messages()) {
      recordSpectrumInbound()
      if (message.messageId) {
        if (seen.has(message.messageId)) continue
        seen.add(message.messageId)
        if (seen.size > DEDUP_CAP) for (const id of Array.from(seen).slice(0, DEDUP_CAP / 2)) seen.delete(id)
      }
      if (message.contentType !== 'text') continue

      // Pacing ON: a fresh inbound supersedes any pending scheduled bubbles for
      // this sender (cheap indexed delete; returns 0 when nothing pending →
      // harmless on the first message of a burst). Fire-and-forget so a cancel
      // failure never throws into the loop. OFF: no-op (no scheduler).
      if (opts.pacingEnabled && opts.scheduler) void opts.scheduler.cancelPending(message.senderId).catch(() => {})

      // ── A layer: abuse cooldown (default-OFF) ──
      if (burst.enabled) {
        const now = Date.now()
        const cd = burstState.get(message.senderId)
        if (cd && cd.cooldownUntil > now) continue // cooling: drop silently (the one notice was sent on entry)
        // Sustained-volume signal via the shared limiter: >perMin*strikes msgs in
        // strikes*60s ("avg >perMin/min for ~strikes min"). A short vent spike stays
        // well under it; a real flood/bot trips it. Keyed distinctly from squad-draft.
        const rl = checkRateLimit(`spectrum:${message.senderId}`, { max: burst.perMin * burst.strikes, windowMs: burst.strikes * 60_000 })
        if (!rl.allowed) {
          burstState.set(message.senderId, { cooldownUntil: now + burst.cooldownMs })
          log('info', 'spectrum_burst_cooldown', { senderId: message.senderId, cooldownMs: burst.cooldownMs })
          await reply.sendText(BURST_COOLDOWN_NOTICE).catch(() => {})
          continue // one notice on entry, then silence for the window
        }
      }

      // ── B layer: supersede (abort) + coalesce (debounce) ──
      const running = inflight.get(message.senderId)
      if (running && !running.ac.signal.aborted) {
        if (burst.enabled && running.refolds < burst.maxRefolds) {
          // abort-then-refold: kill the in-flight turn (its reply is suppressed by
          // the not-aborted gate so no stale reply leaks — Bobby's intent) and carry
          // its texts into the next buffer so the whole thought is answered once.
          running.ac.abort()
          const carried = running.texts
          const refolds = running.refolds + 1
          const existing = buffers.get(message.senderId)
          if (existing) {
            existing.texts = [...carried, ...existing.texts, message.text]
            existing.refolds = Math.max(existing.refolds, refolds)
            clearTimeout(existing.timer)
            existing.timer = setTimeout(() => void flush(message.senderId), debounceMs)
          } else {
            buffers.set(message.senderId, { texts: [...carried, message.text], reply, refolds, timer: setTimeout(() => void flush(message.senderId), debounceMs) })
          }
          continue
        }
        // OFF path: today's behavior — abort, the latest starts fresh.
        // ON + refold cap reached: do NOT abort; let the in-flight finish (its
        // reply goes out), and this message buffers below; its flush waits (guard
        // above) until the in-flight clears, so it rides the next turn.
        if (!burst.enabled) running.ac.abort()
      }
      const existing = buffers.get(message.senderId)
      if (existing) {
        existing.texts.push(message.text)
        clearTimeout(existing.timer)
        existing.timer = setTimeout(() => void flush(message.senderId), debounceMs)
      } else {
        // All messages in a per-sender burst share one conversation; the first
        // message's reply handle is representative for the coalesced turn.
        const entry = { texts: [message.text], reply, refolds: 0, timer: setTimeout(() => void flush(message.senderId), debounceMs) }
        buffers.set(message.senderId, entry)
      }
    }
  } finally {
    if (sweep) clearInterval(sweep)
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
  // Runs the orchestrator and returns the final reply text (or ''). delayContext
  // is forwarded to the orchestrator as a per-turn system note; '' when none.
  // `reply` is passed so an in-turn { type:'reaction' } event (George tapping
  // back via react_to_user) can be applied to the inbound message immediately.
  runOrchestratorText: (userId: string, text: string, abortController?: AbortController, delayContext?: string, reply?: ReplyHandle) => Promise<string>
  normalizeHandle: (raw: string) => string
}

export function buildTextHandler(deps: TextHandlerDeps) {
  return async (rawUserId: string, text: string, reply: ReplyHandle, abortController?: AbortController, delayContext?: string): Promise<string | null> => {
    const userId = deps.normalizeHandle(rawUserId)
    // Gates run on the RAW user text only — delayContext is never part of what's
    // checked, handshake-parsed, or command-matched; it only reaches the agent.
    if (deps.checkInjection(text).blocked) return deps.pickRejection()
    if (await deps.tryHandshake(userId, text, reply)) return null
    const cmd = await deps.tryUserCommand(userId, text)
    if (cmd !== null) return cmd
    const out = await deps.runOrchestratorText(userId, text, abortController, delayContext, reply)
    return out || null
  }
}

// Build the downstream pipeline handlers (injection → handshake → user
// commands → orchestrator). Pure of any connection — reused across reconnects.
// Exported for tests (the three-state user-row save in runOrchestratorText is the
// burst guard's load-bearing correctness path). Not part of the public adapter API.
export function buildSpectrumHandlers(deps: SpectrumAdapterDeps): SpectrumHandlers {
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

      // Resilience branch: a pending-but-already-greeted user texts in. Either the
      // greeting's link send (msg 3) was dropped by a flaky transport, or they got
      // the link and never finished the form. Re-send JUST the link, throttled to
      // at most one nudge per ONBOARDING_RELINK_HOURS so it never spams. byHandle
      // is status='pending', so completed users are excluded automatically; the
      // !greeted_at case above owns the full re-greet, so this only fires once
      // greeted. A recently-reminded user falls through to the orchestrator.
      if (byHandle && byHandle.greeted_at && shouldRelink(byHandle.reminded_at)) {
        await resendOnboardLink({
          code: byHandle.code,
          imessageHandle: userId,
          sendImessage: send,
          markReminded: (c: string) => markReminded(supabase, c),
          profileUrlBase: common.profileUrlBase,
        })
        log('info', 'onboarding_relink', { code: byHandle.code })
        return true
      }
      return false
    },

    tryUserCommand: async (userId: string, text: string) => {
      const pingsReply = await tryPingsCommand(userId, text)
      if (pingsReply !== null) return pingsReply
      return tryHandleUserCommand(userId, text)
    },

    runOrchestratorText: async (userId: string, text: string, abortController?: AbortController, delayContext?: string, reply?: ReplyHandle): Promise<string> => {
      const turnStart = Date.now()
      const burst = readBurstConfig()
      const saveUserTurn = async () => {
        if (deps.sessionStore) {
          await deps.sessionStore.save(userId, {
            sessionId: userId,
            messages: [{ role: 'user', content: text }],
            systemContext: {},
          })
        }
      }
      // OFF path: persist the user turn BEFORE running so it survives an
      // orchestrator failure (today's behavior, byte-for-byte). ON path: defer to
      // AFTER the run so a SUPERSEDED (aborted) turn persists nothing — its text is
      // refolded into the next turn — while a genuine ERROR still saves the user
      // turn (see the catch), keeping the survives-failure guarantee. Deferring
      // also removes a pre-existing dup (the just-saved row showed up in
      // buildHistoryPrefix AND as the live prompt text).
      if (!burst.enabled) await saveUserTurn()
      let finalText = ''
      let turnTelemetry: import('../agent/session-store.js').TurnTelemetry | undefined
      try {
        for await (const event of runOrchestrator({
          userId,
          channel: 'imessage',
          text,
          sessionStore: deps.sessionStore,
          profileStore: deps.profileStore,
          abortController,
          delayContext,
        })) {
          const e = event as {
            type?: string
            result?: string
            emoji?: string
            telemetry?: import('../agent/session-store.js').TurnTelemetry
            message?: { content?: Array<{ type?: string; text?: string }> }
          }
          if (e.type === 'reaction' && typeof e.emoji === 'string' && e.emoji && reply?.react) {
            // George tapped back (react_to_user). Apply the native iMessage
            // tapback to the inbound message; best-effort, never blocks the reply.
            void reply.react(e.emoji).catch(() => {})
          } else if (e.type === 'telemetry') {
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
      } catch (err) {
        // ON path: a SUPERSEDED (aborted) turn persists NOTHING — its text is
        // refolded into the next turn. A genuine ERROR still saves the user turn
        // so the message survives the failure (today's guarantee). OFF path:
        // rethrow exactly as before (the loop's flush catch logs it).
        if (burst.enabled) {
          if (!abortController?.signal.aborted) await saveUserTurn()
          return ''
        }
        throw err
      }
      // ON path: superseded after completing → persist nothing, send nothing.
      if (burst.enabled && abortController?.signal.aborted) return ''
      // ON path: completed and not superseded → persist the user turn now
      // (deferred from before-run).
      if (burst.enabled) await saveUserTurn()
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
      // Fire-and-forget per-turn evaluator dispatch (relationship-note rewrite +
      // activity-phase telemetry). Each evaluator is default-OFF and gated inside
      // the dispatcher, so this is a no-op loop when no turn-evaluator is enabled.
      //
      // Off-path discipline: gate the WHOLE context build behind "any turn
      // evaluator enabled" so an all-flags-off turn never pays the extra
      // countUserMessages DB read — byte-for-byte the same as before this hook.
      if (deps.profileStore && deps.sessionStore && finalText && TURN_EVALUATORS.some((e) => e.isEnabled())) {
        const sessions = deps.sessionStore
        const store = deps.profileStore
        void (async () => {
          try {
            // Cadence keys off the CUMULATIVE user-message count (not the recent
            // window), so "every Nth message" keeps advancing past the 20-message
            // history cap instead of plateauing and firing every turn.
            const userMessageCount = await sessions.countUserMessages(userId)
            const ctx: EvalContext = {
              userId,
              now: new Date(),
              sessionStore: sessions,
              profileStore: store,
              userMessageCount,
              trigger: 'turn',
            }
            await dispatchEvaluators(TURN_EVALUATORS, ctx)
          } catch (err) {
            log('warn', 'turn_evaluator_dispatch_failed', { error: (err as Error).message })
          }
        })()
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
// Pacing drainer handle (default-OFF: null). Started ONCE at the top of
// startSpectrumAdapter so it persists across reconnects, and stopped on loop
// exit and in stopSpectrumAdapter. Module-level so the shutdown path can reach it.
let activeDrainer: { stop(): void } | null = null
// Pacing queue pruner handle (default-OFF: null). Started alongside the drainer
// when pacing is on, and stopped on loop exit and in stopSpectrumAdapter so the
// delivered-row prune never outlives the adapter. Module-level so the shutdown
// path can reach it (mirrors activeDrainer).
let activePruner: { stop(): void } | null = null

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

  // Reliability watchdog: self-heal a silently-wedged Spectrum stream by
  // restarting the process (Railway brings up a fresh connection). Default-OFF —
  // startSpectrumWatchdog installs NO timer unless SPECTRUM_WATCHDOG_ENABLED is
  // on, so the default path is byte-identical to before. See spectrum-watchdog.ts.
  startSpectrumWatchdog()

  // Pacing & Delivery v1 (default-OFF). When enabled, create the durable
  // scheduler (service-role Supabase) ONCE and start the drainer ONCE, BEFORE the
  // reconnect loop, so the drainer survives reconnects. Its send fn resolves the
  // live client per-tick: if there's no connection it THROWS, leaving the row
  // pending → retried next tick after reconnect (correct). When disabled, nothing
  // is created and runSpectrumLoop runs exactly as before (byte-identical).
  const pacing = readPacingConfig()
  let scheduler: OutgoingScheduler | null = null
  if (pacing.enabled) {
    const db = createSupabaseOutgoingSchedulerDB()
    scheduler = createOutgoingScheduler(db)
    const sendFn = async (handle: string, content: string): Promise<void> => {
      const c = getActiveSpectrumClient()
      if (!c) throw new Error('no_spectrum_connection')
      await c.sendProactive(handle, [content])
    }
    activeDrainer = startDrainer(scheduler, sendFn, { intervalMs: pacing.drainIntervalMs })
    // Keep the delivered-bubble table bounded: prune SENT rows > 24h old, hourly.
    activePruner = startQueuePruner(db, {})
    log('info', 'spectrum_pacing_enabled', { drainIntervalMs: pacing.drainIntervalMs })
  }

  try {
    while (!spectrumStopping) {
      try {
        const client = await createSpectrumClient(creds)
        activeSpectrumClient = client
        backoffMs = 1_000 // reset after a successful connect
        log('info', 'spectrum_connected', {})
        recordSpectrumConnect()
        if (scheduler) {
          await runSpectrumLoop(client, handlers, { scheduler, pacingEnabled: true })
        } else {
          await runSpectrumLoop(client, handlers)
        }
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
  } finally {
    // Stop the drainer when the reconnect loop exits (clean shutdown or otherwise)
    // so it never outlives the adapter. No-op when pacing was off.
    if (activeDrainer) {
      activeDrainer.stop()
      activeDrainer = null
    }
    // Same for the queue pruner — no-op when pacing was off.
    if (activePruner) {
      activePruner.stop()
      activePruner = null
    }
  }
  log('info', 'spectrum_adapter_stopped', {})
}

// Close the live Spectrum connection cleanly and stop the reconnect loop.
// Called from the process shutdown handler so a restart never orphans a
// connection on Photon's side.
export async function stopSpectrumAdapter(): Promise<void> {
  spectrumStopping = true
  // Tear down the watchdog timer first so a clean shutdown never trips it (no-op
  // when the watchdog was never started, i.e. the default-OFF path).
  stopSpectrumWatchdog()
  // Stop the pacing drainer so it doesn't keep firing after shutdown (no-op when
  // pacing was off / never started). startSpectrumAdapter's finally also stops it
  // on loop exit; stopping twice is safe (clearInterval on a cleared id no-ops).
  if (activeDrainer) {
    activeDrainer.stop()
    activeDrainer = null
  }
  // Same for the queue pruner (no-op when pacing was off / never started).
  if (activePruner) {
    activePruner.stop()
    activePruner = null
  }
  const client = activeSpectrumClient
  activeSpectrumClient = null
  if (client) await client.close().catch(() => {})
}

// Expose the live connection to out-of-band senders (e.g. squad-ping fan-out).
// Returns null if the Spectrum adapter is not running or currently reconnecting.
export function getActiveSpectrumClient(): SpectrumClient | null {
  return activeSpectrumClient
}
