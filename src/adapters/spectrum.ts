// src/adapters/spectrum.ts
// Spectrum transport adapter. Owns the inbound loop, last-N dedup, text routing
// to the unchanged downstream pipeline, the Find My location path, and outbound
// replies via the conversation space. The ONLY file aware of Spectrum.
//
// Header last reviewed: 2026-06-11

import type { SpectrumClient, ReplyHandle } from './spectrum-client.js'

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
    try {
      const out = await handlers.handleText(senderId, buf.texts.join('\n'), buf.reply)
      if (out) await buf.reply.sendText(out)
    } catch { /* per-turn isolation */ }
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
      const entry = { texts: [message.text], reply, timer: setTimeout(() => void flush(message.senderId), debounceMs) }
      buffers.set(message.senderId, entry)
    }
  }
  // Drain any pending buffers when the stream ends.
  await Promise.all(Array.from(buffers.keys()).map(flush))
}
