// src/onboarding/handshake.ts
// 3-message greeting sequence triggered by "<code>-START" iMessage.
// Bundles greeting+vcf into msg 1, intro+5-image carousel into msg 2, profile
// link as msg 3. Compresses what was 9 individual sends into 3 — way lower
// latency through Messages.app and showcase images render as a proper grid
// instead of scrolling spam.
import fs from 'node:fs';
import { isValidCodeFormat } from './code-generator.js';
import { SHOWCASE, CONTACT_CARD_PATH } from './showcase.js';
import type { PendingUser } from './pending-users.js';

// Showcase images smaller than this are placeholder stubs (the committed
// 70-byte PNGs). Sending them produces five broken-image bubbles — worse than
// no images. Until real assets land, message 2 degrades to text-only captions.
// Exported for testing.
export const MIN_REAL_IMAGE_BYTES = 1024;

export function usableImagePaths(paths: string[]): string[] {
  return paths.filter((p) => {
    try {
      return fs.statSync(p).size >= MIN_REAL_IMAGE_BYTES;
    } catch {
      return false;
    }
  });
}

// Two accepted formats:
//   1. New (preferred): "...george...(g7k2m4)" — natural sentence shape that
//      the web prefill writes ("i'm ready to try george (g7k2m4)"). Requires
//      both the word "george" and a parenthesized 6-char code so a casual chat
//      message containing parens won't false-positive into the handshake.
//   2. Legacy: "g7k2m4-START" — bare code with -START suffix. Kept so any
//      links a freshman captured before the prefill change still work.
const HANDSHAKE_RE_NATURAL = /george[^()]*\(([a-z0-9]{6})\)/i;
const HANDSHAKE_RE_LEGACY = /^([a-z0-9]{6})-START$/i;

export interface ExtractedHandshake {
  code: string;
  // 'legacy' is the unambiguous "<code>-START" shape; 'natural' can
  // false-positive on real sentences ("ask george (senior) about housing"),
  // so a natural code that misses the pending_users lookup must fall through
  // to the orchestrator instead of replying with a code error.
  format: 'natural' | 'legacy';
}

export function extractCodeFromStartMessage(text: string): ExtractedHandshake | null {
  const trimmed = text.trim();
  const legacy = trimmed.match(HANDSHAKE_RE_LEGACY);
  if (legacy) {
    const code = legacy[1].toLowerCase();
    if (isValidCodeFormat(code)) return { code, format: 'legacy' };
  }
  const natural = trimmed.match(HANDSHAKE_RE_NATURAL);
  if (natural) {
    const code = natural[1].toLowerCase();
    if (isValidCodeFormat(code)) return { code, format: 'natural' };
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
  format: 'natural' | 'legacy';
  imessageHandle: string;
  sendImessage: (msg: OutgoingMessage) => Promise<void>;
  lookupPending: (code: string) => Promise<PendingUser | null>;
  linkImessageHandle: (code: string, imessageHandle: string) => Promise<void>;
  profileUrlBase: string;
  // Optional: stamp pending_users.greeted_at after the greeting so the
  // by-handle path (Spectrum signup funnel: prefilled "Hi") never re-greets.
  markGreeted?: (code: string) => Promise<void>;
}

// Returns true when the message was consumed by the handshake flow (greeting
// sent, already-completed reply, or legacy code error). Returns false when a
// natural-format code missed the lookup — the caller must fall through to the
// orchestrator because the message is most likely a real conversation that
// happened to contain "george (xxxxxx)".
export async function runHandshake(opts: HandshakeOptions): Promise<boolean> {
  const pending = await opts.lookupPending(opts.code);
  if (!pending) {
    if (opts.format === 'natural') return false;
    await opts.sendImessage({
      to: opts.imessageHandle,
      text: `couldn't find that code. did you mean to send your 6-char welcome code from uscbia.com/george?`,
    });
    return true;
  }
  if (pending.status === 'completed') {
    await opts.sendImessage({
      to: opts.imessageHandle,
      text: "you're already in. just say what's on your mind.",
    });
    return true;
  }

  // Link the handle up front: binding identity is correct even if the greeting
  // send below fails, and it's a cheap idempotent write.
  await opts.linkImessageHandle(opts.code, opts.imessageHandle);

  // Message 1: greeting + vcf contact card (single iMessage with text + file)
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: "yo, welcome. I'm george. save my contact so I stay in your messages.",
    filePaths: [CONTACT_CARD_PATH],
  });

  // Stamp greeted AFTER the first send succeeds, not before. The by-handle path
  // keys off greeted_at to decide whether to greet. Two failure modes to balance:
  //   - Mark up front: a flaky transport that drops the very first send still
  //     leaves the user marked greeted but with nothing delivered, and the
  //     by-handle re-greet path (`!greeted_at`) never fires again — the user is
  //     silently stuck, never onboarded. This is the prod bug we're fixing.
  //   - Mark after the WHOLE welcome: a follow-up arriving mid-greeting (the
  //     slow part is sends 2-3) would re-trigger the whole welcome.
  // Marking here splits the difference: a first-send failure throws before this
  // line, so the user is NOT marked greeted and gets re-greeted next time; once
  // the greeting has actually landed we mark immediately, so the slow carousel +
  // link sends (2-3) can't be raced into a re-greet. If sends 2-3 fail the user
  // stays greeted — acceptable, they got the real greeting, and re-greeting would
  // just re-send message 1 they already have.
  if (opts.markGreeted) await opts.markGreeted(opts.code);

  // Message 2: intro + 5-image carousel (single iMessage with text + grid).
  // Placeholder/missing images are filtered out; zero real images → text-only.
  const captionsList = SHOWCASE.map((s) => `• ${s.caption}`).join('\n');
  const realImages = usableImagePaths(SHOWCASE.map((s) => s.path));
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `here's what I can do.\n\n${captionsList}`,
    ...(realImages.length > 0 ? { imagePaths: realImages } : {}),
  });

  // Message 3: profile link
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `ready to set up? takes 2 min. ${opts.profileUrlBase}?code=${opts.code}`,
  });
  return true;
}

// Default throttle window for the link-resend nudge: at most one resend per 24h
// per pending user until they complete the profile form.
const DEFAULT_RELINK_HOURS = 24;

// Throttle gate for resendOnboardLink. Returns true when a pending-but-greeted
// user is due for another link nudge: never reminded (null) OR last reminded
// longer ago than ONBOARDING_RELINK_HOURS (default 24). Pure + exported so the
// spectrum branch ordering stays unit-testable without a live clock or DB.
export function shouldRelink(remindedAt: string | null, now: Date = new Date()): boolean {
  if (!remindedAt) return true;
  const hours = Number(process.env.ONBOARDING_RELINK_HOURS) || DEFAULT_RELINK_HOURS;
  const last = new Date(remindedAt).getTime();
  return now.getTime() - last >= hours * 60 * 60 * 1000;
}

// Subset of HandshakeOptions for the link-only resend path. Carries just what a
// single link send + reminded stamp needs.
export interface ResendOnboardLinkOptions {
  code: string;
  imessageHandle: string;
  sendImessage: (msg: OutgoingMessage) => Promise<void>;
  markReminded: (code: string) => Promise<void>;
  profileUrlBase: string;
}

// Self-heal for pending-not-completed users: the greeting landed (greeted_at set)
// but they either never received the link (sends 2-3 dropped) or got it and never
// finished the form. Re-send ONLY the link with a short nudge.
//
// markReminded runs AFTER the send succeeds, mirroring the greeted-after-send
// guarantee in runHandshake: a failed resend throws before stamping reminded_at,
// so the user is NOT throttled out and gets re-nudged on their next message.
// Returns true (it handled the message).
export async function resendOnboardLink(opts: ResendOnboardLinkOptions): Promise<boolean> {
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `looks like you didn't finish setting up yet, here's your link again: ${opts.profileUrlBase}?code=${opts.code}`,
  });
  await opts.markReminded(opts.code);
  return true;
}
