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

export async function runSpectrumLoop(client: SpectrumClient, handlers: SpectrumHandlers): Promise<void> {
  const seen = new Set<string>()
  for await (const [reply, message] of client.messages()) {
    if (message.messageId) {
      if (seen.has(message.messageId)) continue
      seen.add(message.messageId)
      if (seen.size > DEDUP_CAP) {
        for (const id of Array.from(seen).slice(0, DEDUP_CAP / 2)) seen.delete(id)
      }
    }
    try {
      if (message.contentType === 'text') {
        const out = await handlers.handleText(message.senderId, message.text, reply)
        if (out) await reply.sendText(out)
      }
    } catch {
      // Per-message isolation: one bad message never kills the loop.
    }
  }
}
