// src/onboarding/handshake.ts
// 5-message greeting sequence triggered by "<code>-START" iMessage.
import { isValidCodeFormat } from './code-generator.js';
import { SHOWCASE, CONTACT_CARD_PATH } from './showcase.js';
import type { PendingUser } from './pending-users.js';

const START_RE = /^([a-z0-9]{6})-START$/i;

export function extractCodeFromStartMessage(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(START_RE);
  if (!m) return null;
  const code = m[1].toLowerCase();
  if (!isValidCodeFormat(code)) return null;
  return code;
}

export interface OutgoingMessage {
  to: string;
  text?: string;
  attachmentPath?: string;
  caption?: string;
}

export interface HandshakeOptions {
  code: string;
  imessageHandle: string;
  sendImessage: (msg: OutgoingMessage) => Promise<void>;
  lookupPending: (code: string) => Promise<PendingUser | null>;
  linkImessageHandle: (code: string, imessageHandle: string) => Promise<void>;
  profileUrlBase: string;
}

export async function runHandshake(opts: HandshakeOptions): Promise<void> {
  const pending = await opts.lookupPending(opts.code);
  if (!pending) {
    await opts.sendImessage({
      to: opts.imessageHandle,
      text: `couldn't find that code. did you mean to send your 6-char welcome code from uscbia.com/george?`,
    });
    return;
  }
  if (pending.status === 'completed') {
    await opts.sendImessage({
      to: opts.imessageHandle,
      text: "you're already in. just say what's on your mind.",
    });
    return;
  }

  await opts.linkImessageHandle(opts.code, opts.imessageHandle);

  // Message 1: greeting
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: "yo, welcome. I'm george. save my contact below so I stay in your messages.",
  });

  // Message 2: contact card attachment
  await opts.sendImessage({
    to: opts.imessageHandle,
    attachmentPath: CONTACT_CARD_PATH,
  });

  // Message 3: intro line
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: "here's what I can do.",
  });

  // Messages 4-8: showcase images with captions
  for (const item of SHOWCASE) {
    await opts.sendImessage({
      to: opts.imessageHandle,
      attachmentPath: item.path,
      caption: item.caption,
    });
  }

  // Message 9: profile link
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `ready to set up? takes 2 min. ${opts.profileUrlBase}?code=${opts.code}`,
  });
}
