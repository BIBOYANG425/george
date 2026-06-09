// src/onboarding/handshake.ts
// 3-message greeting sequence triggered by "<code>-START" iMessage.
// Bundles greeting+vcf into msg 1, intro+5-image carousel into msg 2, profile
// link as msg 3. Compresses what was 9 individual sends into 3 — way lower
// latency through Messages.app and showcase images render as a proper grid
// instead of scrolling spam.
import { isValidCodeFormat } from './code-generator.js';
import { SHOWCASE, CONTACT_CARD_PATH } from './showcase.js';
import type { PendingUser } from './pending-users.js';

// Two accepted formats:
//   1. New (preferred): "...george...(g7k2m4)" — natural sentence shape that
//      the web prefill writes ("i'm ready to try george (g7k2m4)"). Requires
//      both the word "george" and a parenthesized 6-char code so a casual chat
//      message containing parens won't false-positive into the handshake.
//   2. Legacy: "g7k2m4-START" — bare code with -START suffix. Kept so any
//      links a freshman captured before the prefill change still work.
const HANDSHAKE_RE_NATURAL = /george[^()]*\(([a-z0-9]{6})\)/i;
const HANDSHAKE_RE_LEGACY = /^([a-z0-9]{6})-START$/i;

export function extractCodeFromStartMessage(text: string): string | null {
  const trimmed = text.trim();
  const natural = trimmed.match(HANDSHAKE_RE_NATURAL);
  if (natural) {
    const code = natural[1].toLowerCase();
    if (isValidCodeFormat(code)) return code;
  }
  const legacy = trimmed.match(HANDSHAKE_RE_LEGACY);
  if (legacy) {
    const code = legacy[1].toLowerCase();
    if (isValidCodeFormat(code)) return code;
  }
  return null;
}

export interface OutgoingMessage {
  to: string;
  text?: string;
  imagePaths?: string[];
  filePaths?: string[];
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

  // Message 1: greeting + vcf contact card (single iMessage with text + file)
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: "yo, welcome. I'm george. save my contact so I stay in your messages.",
    filePaths: [CONTACT_CARD_PATH],
  });

  // Message 2: intro + 5-image carousel (single iMessage with text + grid)
  const captionsList = SHOWCASE.map((s) => `• ${s.caption}`).join('\n');
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `here's what I can do.\n\n${captionsList}`,
    imagePaths: SHOWCASE.map((s) => s.path),
  });

  // Message 3: profile link
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `ready to set up? takes 2 min. ${opts.profileUrlBase}?code=${opts.code}`,
  });
}
