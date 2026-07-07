// src/agent/collect-reply.ts
// One shared consumer for a runOrchestrator() event stream. Five transports
// (POST /chat, POST /chat/stream, Path B /imessage/incoming, the local iMessage
// adapter, and the Spectrum text handler) each used to hand-roll the SAME reducer
// — take the final reply from a `result` event, fall back to the first `assistant`
// message's text, and capture the trailing `telemetry`. Collapsing them here means
// a change to that reduction lands in one place instead of drifting across copies.
//
// Per-transport behavior is preserved via optional hooks: only the SSE and Path B
// callers render the "checking…" interstitial, and only Spectrum applies George's
// react_to_user tapback. A caller that omits a hook ignores that event exactly as
// its hand-rolled loop did. The wechat adapter is intentionally NOT a caller — it
// collects `type:'text'` events (a different reduction), so it stays as-is.
//
// Header last reviewed: 2026-07-07
import type { TurnTelemetry } from './session-store.js';

// The union of shapes runOrchestrator yields: our synthetic control events
// (result / interstitial / reaction / telemetry) plus raw SDK messages
// (type:'assistant' with a content array). Mirrors the per-loop casts verbatim.
export interface OrchestratorEvent {
  type?: string;
  text?: string;
  result?: string;
  emoji?: string;
  telemetry?: TurnTelemetry;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

export interface CollectHooks {
  // Fired for each "checking…" interstitial the orchestrator emits, ONLY when it
  // carries non-empty text (matches the `&& e.text` / `if (e.text)` guards the SSE
  // and Path B loops used). Omit to ignore interstitials, as the other loops do.
  onInterstitial?: (text: string) => void | Promise<void>;
  // Fired when George taps back (react_to_user) with a non-empty emoji. Only the
  // Spectrum transport supplies this (native iMessage tapback); omit elsewhere.
  onReaction?: (emoji: string) => void | Promise<void>;
}

export interface CollectedReply {
  // The final reply text: a non-empty `result` if one arrived, else the first
  // `assistant` message's joined text, else '' (nothing to send).
  text: string;
  // The trailing per-turn telemetry event, when the stream emitted one. Callers
  // that persist an assistant turn attach it; the local iMessage adapter ignores it.
  telemetry?: TurnTelemetry;
}

// Drain a runOrchestrator stream into { text, telemetry }, firing the supplied
// hooks for interstitial / reaction events along the way. Any error thrown by the
// underlying iteration (e.g. an aborted/superseded turn) propagates to the caller,
// exactly as the hand-rolled `for await` loops did.
export async function collectOrchestratorReply(
  events: AsyncIterable<OrchestratorEvent>,
  hooks?: CollectHooks,
): Promise<CollectedReply> {
  let text = '';
  let telemetry: TurnTelemetry | undefined;
  for await (const event of events) {
    const e = event as OrchestratorEvent;
    // Each event has exactly one `type`, so these branches are mutually exclusive;
    // the order only groups the synthetic control events ahead of the reply events.
    if (e.type === 'reaction') {
      if (typeof e.emoji === 'string' && e.emoji) await hooks?.onReaction?.(e.emoji);
    } else if (e.type === 'interstitial') {
      if (e.text) await hooks?.onInterstitial?.(e.text);
    } else if (e.type === 'telemetry') {
      telemetry = e.telemetry;
    } else if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
      text = e.result;
    } else if (e.type === 'assistant' && e.message?.content && text === '') {
      const t = e.message.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (t) text = t;
    }
  }
  return { text, telemetry };
}
