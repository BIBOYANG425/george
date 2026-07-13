// Vendored from imessage-agent-observability-boilerplate
// (packages/adapters/spectrum-imessage/src/index.ts), import path localized.

// Reference adapter: Spectrum (spectrum-ts) iMessage provider → NormalizedMessage.
//
// Field notes learned from production:
//   • The transport (iMessage/SMS/RCS) rides on message.sender.service — the
//     provider's userSchema merges it onto the sender. It is per-message but
//     OPTIONAL in cloud mode; the core SDK's sticky-channel rule covers gaps.
//   • Do NOT call space.getMembers() to get it — that throws UnsupportedError
//     on DMs ("only group chats support listing members").
//   • Outbound send() results don't carry the transport (and Apple decides
//     SMS fallback asynchronously) — use obs.resolveOutboundChannel(handle).

import type { NormalizedMessage, PlatformAdapter } from "./core.js";

/** Structural type for a Spectrum iMessage inbound message (SDK-agnostic). */
export interface SpectrumIMessageLike {
  id: string;
  timestamp?: Date;
  sender?: { id?: string; service?: string; name?: string };
  content:
    | { type: "text"; text: string }
    | { type: "attachment"; mimeType: string; name?: string }
    | { type: string; [k: string]: unknown };
  extra?: { isFromMe?: boolean };
}

export const spectrumIMessageAdapter: PlatformAdapter<SpectrumIMessageLike> = {
  platform: "imessage",

  toEvent(msg): NormalizedMessage | null {
    const handle = msg.sender?.id;
    if (!handle) return null;
    if (msg.extra?.isFromMe) return null; // provider echo of our own send

    const base = {
      conversationId: handle,
      direction: "inbound" as const,
      platform: "imessage",
      channel: msg.sender?.service, // "iMessage" | "SMS" | "RCS" | undefined
      externalId: msg.id,
      timestamp: msg.timestamp,
      senderName: msg.sender?.name,
    };

    if (msg.content.type === "text") {
      return { ...base, contentType: "text", text: (msg.content as { text: string }).text };
    }
    if (msg.content.type === "attachment") {
      const mime = (msg.content as { mimeType: string }).mimeType;
      return { ...base, contentType: mime.startsWith("image/") ? "image" : "attachment" };
    }
    return null; // reactions, typing, etc. — opt in per agent if wanted
  },
};

/**
 * Helper for the outbound side. Call after each space.send():
 *
 *   const channel = await obs.resolveOutboundChannel(handle);
 *   obs.logMessage(outboundEvent(handle, text, channel, sent?.id));
 */
export function outboundEvent(
  handle: string,
  text: string | undefined,
  channel: string,
  externalId?: string,
  contentType: string = "text",
): NormalizedMessage {
  return {
    conversationId: handle,
    direction: "outbound",
    platform: "imessage",
    channel,
    contentType,
    text,
    externalId,
  };
}
