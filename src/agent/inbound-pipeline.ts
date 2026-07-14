// src/agent/inbound-pipeline.ts
// The shared inbound message sequence every text transport runs BEFORE it decides
// what to send: normalize the handle → injection filter → onboarding handshake →
// user command → orchestrator. Each stage short-circuits. Spectrum's buildTextHandler
// was the original hand-rolled copy of this; Path B (/imessage/incoming) had its own.
//
// The result is a DISCRIMINATED outcome, not a flat string, because the transports
// post-process each stage differently (e.g. Path B enqueues a command reply raw but
// runs an orchestrator reply through resolveReply; the Spectrum flush sends every
// non-null reply uniformly). Returning the stage that produced the reply lets each
// caller keep its exact send/persistence behavior while sharing this control flow.
//
// Deps are pure seams (each transport supplies its own handshake / command /
// orchestrate implementation); this file knows nothing about iMessage, Supabase,
// or the SDK. `TReply` is the transport's reply-handle type (Spectrum's ReplyHandle;
// unused by queue-backed transports).
//
// Header last reviewed: 2026-07-13

import type { ImagePart } from './image-part.js';

export interface InboundPipelineDeps<TReply = unknown> {
  // Normalize the raw channel handle before any lookup/save. Optional → identity.
  normalizeHandle?: (raw: string) => string;
  // Boundary injection check on the RAW user text (never on any injected context).
  checkInjection: (text: string) => { blocked: boolean; reason?: string };
  // The in-voice rejection to return when injection blocks the message.
  pickRejection: () => string;
  // Onboarding handshake. Returns true if it consumed the message (send nothing
  // further). Implementations own their error handling (a thrown handshake should
  // be caught inside and turned into `true`/`false`, matching each transport today).
  tryHandshake: (userId: string, text: string, reply?: TReply) => Promise<boolean>;
  // A user control command reply (e.g. /profile), or null when not a command.
  tryUserCommand: (userId: string, text: string) => Promise<string | null>;
  // Run the orchestrator and return the final reply text ('' = nothing to send).
  // Persistence (session save, capture) lives inside the transport's implementation,
  // exactly as it does today. delayContext / reply are forwarded through.
  runOrchestratorText: (
    userId: string,
    text: string,
    abortController?: AbortController,
    delayContext?: string,
    reply?: TReply,
    images?: ImagePart[],
  ) => Promise<string>;
}

export interface InboundInput<TReply = unknown> {
  rawUserId: string;
  text: string;
  reply?: TReply;
  abortController?: AbortController;
  delayContext?: string;
  // Inbound images for this turn (image intake, default-OFF). Forwarded to the
  // orchestrator alongside the text; undefined/empty on the text-only path. Like
  // delayContext, images bypass the injection / handshake / command gates — they
  // reach only runOrchestratorText.
  images?: ImagePart[];
}

// The stage that produced the outcome, so the caller can post-process per stage.
export type InboundOutcome =
  | { kind: 'injection'; reply: string; reason?: string }
  | { kind: 'handshake' }
  | { kind: 'command'; reply: string }
  | { kind: 'orchestrator'; reply: string };

export async function runInboundPipeline<TReply = unknown>(
  deps: InboundPipelineDeps<TReply>,
  input: InboundInput<TReply>,
): Promise<InboundOutcome> {
  const userId = deps.normalizeHandle ? deps.normalizeHandle(input.rawUserId) : input.rawUserId;
  // Gates run on the RAW user text only — delayContext is never checked, parsed, or
  // command-matched; it reaches only the orchestrator.
  const injection = deps.checkInjection(input.text);
  if (injection.blocked) return { kind: 'injection', reply: deps.pickRejection(), reason: injection.reason };
  if (await deps.tryHandshake(userId, input.text, input.reply)) return { kind: 'handshake' };
  const cmd = await deps.tryUserCommand(userId, input.text);
  if (cmd !== null) return { kind: 'command', reply: cmd };
  const out = await deps.runOrchestratorText(userId, input.text, input.abortController, input.delayContext, input.reply, input.images);
  return { kind: 'orchestrator', reply: out };
}
