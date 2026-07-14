// src/adapters/spectrum-stages.ts
//
// The three timing stages extracted from spectrum.ts flush(), so they unit-test
// without a live SpectrumClient. flush() becomes a thin composer over these.
// This is a PURE refactor: each stage holds the exact statements that lived
// inline in flush(), with the same timing constants and abort semantics. The
// control-token suppression, lastReplyAt-only-on-send, and abort-vs-error log
// distinction stay in flush() (NOT pushed into the stages) so suppression
// semantics are preserved exactly.
//
// stageSendPaced is the pacing-ON variant of stageSend (Pacing & Delivery v1,
// Task 4): bubble 0 inline, bubbles 1..N-1 handed to the durable scheduler. The
// OFF-path stageSend is unchanged.
//
// Header last reviewed: 2026-06-24

import type { ReplyHandle } from './spectrum-client.js'
import type { ImagePart } from '../agent/image-part.js'
import {
  splitIntoMessages,
  sleep,
  INTER_MESSAGE_DELAY_MS,
  isReadReceiptDelayEnabled,
} from './split-response.js'

// "Still thinking" interim nudges — moved here with pickStillThinking so the
// generate stage owns the long-turn nudge. Sent once if the orchestrator turn
// runs long (e.g. the course recommender ~30s) so the user knows george is
// working rather than dead. Short, in-voice; the real reply follows when ready.
export const STILL_THINKING = ['等我一下哈，还在翻 🔍', 'gimme a sec, still digging on this', '稍等，马上给你']
export const pickStillThinking = (): string =>
  STILL_THINKING[Math.floor(Math.random() * STILL_THINKING.length)]

// Default interim nudge delay (9s). Same constant flush() used before.
export const INTERIM_DELAY_MS_DEFAULT = 9000

export interface StageReadReceiptOptions {
  // Pre-generation "reading" pause in ms. 0 / unset => no-op.
  readReceiptDelayMs?: number
}

// stageReadReceiptDelay: OPTIONAL, default-OFF pause BEFORE generation, so it
// simulates reading the message — never delaying an already-composed reply.
// No-op (returns immediately) when the flag is off or the duration is <= 0, so
// flush() is byte-for-byte unchanged when the feature is unused.
export async function stageReadReceiptDelay(opts: StageReadReceiptOptions = {}): Promise<void> {
  const ms = opts.readReceiptDelayMs ?? 0
  if (!isReadReceiptDelayEnabled() || !(ms > 0)) return
  await sleep(ms)
}

export interface StageGenerateOptions {
  interimDelayMs?: number
  // Inbound images for this turn (image intake, default-OFF). Undefined/empty on
  // the OFF path, so the handleText call is byte-identical to a text-only turn.
  images?: ImagePart[]
}

// stageGenerate: owns startTyping (best-effort), the interim "still thinking"
// nudge (guarded by !ac.signal.aborted), and awaits handleText. clearTimeout on
// BOTH success AND throw (try/finally). Returns the model output string or null.
// startTyping is best-effort with .catch(()=>{}) so a failed typing signal never
// blocks or fails the reply. Same timing constants and abort semantics as the
// original inline flush() body.
export async function stageGenerate(
  senderId: string,
  texts: string[],
  reply: ReplyHandle,
  ac: AbortController,
  handleText: (
    userId: string,
    text: string,
    reply: ReplyHandle,
    abortController?: AbortController,
    delayContext?: string,
    images?: ImagePart[],
  ) => Promise<string | null>,
  delayContext: string,
  opts: StageGenerateOptions = {},
): Promise<string | null> {
  const interimDelayMs = opts.interimDelayMs ?? INTERIM_DELAY_MS_DEFAULT
  // Show the "…" typing bubble while the (slow) orchestrator turn runs.
  // Best-effort: a failed typing signal must never block or fail the reply.
  await reply.startTyping().catch(() => {})
  // If the turn runs long, send one "still thinking" nudge so the user isn't
  // left staring at a typing bubble. Skipped if the turn was already superseded.
  const interimTimer = setTimeout(() => {
    if (!ac.signal.aborted) void reply.sendText(pickStillThinking()).catch(() => {})
  }, interimDelayMs)
  try {
    // delayContext (if any) rides into the orchestrator as a per-turn system
    // note, NOT prepended to the user text — so it bypasses the injection /
    // handshake / user-command gates and is never persisted as the user's
    // message. '' by default (flag off / short gap).
    const out = await handleText(senderId, texts.join('\n'), reply, ac, delayContext, opts.images)
    return out
  } finally {
    clearTimeout(interimTimer)
  }
}

export interface StageSendOptions {
  interMessageDelayMs?: number
  // Threaded-reply opt-in (default-OFF feature): when true, bubble 0 is sent as a
  // threaded reply anchored to the inbound message (reply.replyThread); the rest
  // send normally. Undefined/false → every bubble is a plain send (unchanged).
  threadFirst?: boolean
}

// stageSend: split the reply into bubbles and send each with the inter-message
// pause. Skipped entirely if the turn was superseded (aborted). Same 600ms
// pacing and same MAX_PARTS=4 split (via splitIntoMessages) as before.
export async function stageSend(
  toSend: string,
  reply: ReplyHandle,
  ac: AbortController,
  opts: StageSendOptions = {},
): Promise<void> {
  if (ac.signal.aborted) return
  const delay = opts.interMessageDelayMs ?? INTER_MESSAGE_DELAY_MS
  const parts = splitIntoMessages(toSend)
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(delay)
    if (i === 0 && opts.threadFirst) await reply.replyThread(parts[i])
    else await reply.sendText(parts[i])
  }
}

export interface StageSendPacedDeps {
  // Persist bubbles 1..N-1 to the durable scheduler for later, paced delivery.
  // Takes the FULL parts array (the scheduler skips bubble 0 itself).
  schedule: (handle: string, bubbles: string[]) => Promise<void>
}

// stageSendPaced: the pacing-ON send stage. Bubble 0 goes out INLINE via
// reply.sendText (responsiveness preserved); bubbles 1..N-1 are handed to the
// durable scheduler and delivered later by the drainer (which survives restarts
// and is cancelled by a fresh inbound). NO in-process loop-sleep here — the
// pacing gap lives entirely in the scheduler's persisted send_at timestamps.
// Skipped entirely if the turn was superseded (aborted), matching stageSend.
export async function stageSendPaced(
  toSend: string,
  reply: ReplyHandle,
  handle: string,
  ac: AbortController,
  deps: StageSendPacedDeps,
  opts: { threadFirst?: boolean } = {},
): Promise<void> {
  if (ac.signal.aborted) return
  const parts = splitIntoMessages(toSend)
  if (parts.length === 0) return
  // Bubble 0 inline — keeps George's first-line responsiveness identical to the
  // OFF path. NEVER persisted (the scheduler also drops index 0 defensively).
  // Threaded-reply opt-in threads this inline anchor bubble; the deferred tail
  // (scheduled below) always sends as plain bubbles.
  if (opts.threadFirst) await reply.replyThread(parts[0])
  else await reply.sendText(parts[0])
  // Defer the tail. schedule() takes the FULL array and persists only [1..N-1].
  if (parts.length > 1) await deps.schedule(handle, parts)
}
