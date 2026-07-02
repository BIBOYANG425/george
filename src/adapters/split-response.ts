/**
 * Split an agent response into multiple chat messages on blank-line boundaries.
 *
 * Background: a real WeChat / iMessage conversation reads as a burst of short
 * lines, not one paragraph. George's prompt tells the model to separate logical
 * beats with a blank line; this helper cashes those blank lines in at the
 * adapter layer so the receiving side sees N separate bubbles.
 *
 * Guardrails:
 *  - Trim each part; drop empties.
 *  - Cap at MAX_PARTS. If the model emits more, merge the tail into the last
 *    kept part so nothing is silently dropped.
 *  - Keep the source message order.
 *
 * Also hosts parseControlTokens(): a tiny, pure parser for output-format control
 * tokens George may emit. Today the only token is {{NO_REPLY}}, which lets the
 * model decline to reply at all (pure acks, automated texts). Parsing is always
 * safe to call — it only *detects* the token and strips it; whether a detected
 * {{NO_REPLY}} actually suppresses the send is gated by GEORGE_NOREPLY_ENABLED at
 * the call sites (default OFF). The token is always stripped from outgoing text
 * so it can never reach a user even if a backend echoes it.
 *
 * Header last reviewed: 2026-06-18
 */

// Hard cap on parts per reply. Above this, WeChat / iMessage starts looking
// like spam and the user loses the thread. Merge the tail into the last part.
const MAX_PARTS = 4

import { stripMarkdown } from './strip-markdown.js'
import { sanitizeDashes, stripSourcesFooter } from '../agent/voice-guard.js'

export function splitIntoMessages(response: string): string[] {
  if (!response) return []
  // Strip markdown before splitting — WeChat / iMessage render it literally, and
  // models sometimes emit it despite the prompt forbidding it.
  const parts = stripMarkdown(response)
    .split(/\n\s*\n/) // blank-line boundary (tolerates trailing whitespace)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  if (parts.length === 0) return []

  // Cap at MAX_PARTS; append the overflow to the last kept part on its own line.
  if (parts.length <= MAX_PARTS) return parts
  const kept = parts.slice(0, MAX_PARTS - 1)
  const tail = parts.slice(MAX_PARTS - 1).join('\n')
  kept.push(tail)
  return kept
}

// Output-format control token: the model may emit {{NO_REPLY}} to decline to
// reply (a pure ack, an automated/system text, or a conversation that has wound
// down). Matched case-insensitively, tolerant of inner whitespace, anywhere in
// the text. Kept here next to splitIntoMessages because both are the adapter-layer
// translation of in-band control markers George writes into its reply.
const NO_REPLY_TOKEN = /\{\{\s*NO_REPLY\s*\}\}/gi

export interface ControlTokens {
  // True if the reply carried a {{NO_REPLY}} token anywhere.
  noReply: boolean
  // The reply text with every control token removed and re-trimmed. When noReply
  // is true this is usually empty, but a model may pad the token with stray
  // words; callers that honor noReply ignore this, callers that don't still get
  // clean, token-free text to send.
  text: string
}

// Detect + strip output-format control tokens from a raw model reply. Pure: no
// env reads, no side effects. Always safe to call on any reply — it never throws
// and, when no token is present, returns the input trimmed with noReply:false.
// The two jobs (does this reply opt out? / give me text with no stray markers)
// are intentionally split so the env flag can gate suppression while stripping
// stays unconditional (a stray token must never reach a user).
export function parseControlTokens(response: string): ControlTokens {
  if (!response) return { noReply: false, text: response ?? '' }
  const noReply = NO_REPLY_TOKEN.test(response)
  // Reset lastIndex: the regex is /g, so .test() above advanced it.
  NO_REPLY_TOKEN.lastIndex = 0
  // Voice enforcement in CODE, not just prompt (the model emits these tells
  // despite explicit bans — measured on the 2026-07-02 100-persona sim:
  // em-dashes ~35% of conversations, Sources footers 56% / markdown links 52%
  // of slim-arm replies). Order: drop citation footers, then strip markdown
  // (incl. [label](url) -> label), then rewrite dashes.
  const text = sanitizeDashes(stripMarkdown(stripSourcesFooter(response.replace(NO_REPLY_TOKEN, '')))).trim()
  return { noReply, text }
}

// Convenience for the send sinks that don't themselves decide suppression: strip
// any control token out of outgoing text so it can never be shown to a user.
// (Equivalent to parseControlTokens(text).text but reads clearer at call sites.)
export function stripControlTokens(response: string): string {
  return parseControlTokens(response).text
}

// True when the {{NO_REPLY}} opt-out is enabled. Default OFF: when the env var is
// unset the parser still strips tokens, but a detected {{NO_REPLY}} does NOT
// suppress the reply, so behavior is byte-for-byte unchanged from before.
export function isNoReplyEnabled(): boolean {
  return process.env.GEORGE_NOREPLY_ENABLED === 'true'
}

// Inter-message delay that feels like typing, not a flood. 600ms is long
// enough for the recipient's client to render the prior bubble, short enough
// that conversation doesn't stall.
export const INTER_MESSAGE_DELAY_MS = 600

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Read-receipt delay: an OPTIONAL, default-OFF pause BEFORE George composes a
// reply, simulating "reading" the message before answering. This is the only
// sanctioned intentional delay and it is PRE-generation (it never delays an
// already-composed reply — that is forbidden). Gated by
// GEORGE_READRECEIPT_DELAY_ENABLED; the duration is GEORGE_READRECEIPT_DELAY_MS
// (NaN / negative -> 0). When the flag is off or the duration is 0, the stage
// is a no-op so flush() is byte-for-byte unchanged.
export function isReadReceiptDelayEnabled(): boolean {
  return process.env.GEORGE_READRECEIPT_DELAY_ENABLED === 'true'
}

export function getReadReceiptDelayMs(): number {
  const raw = process.env.GEORGE_READRECEIPT_DELAY_MS
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}
