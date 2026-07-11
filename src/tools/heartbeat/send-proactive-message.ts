// src/tools/heartbeat/send-proactive-message.ts
// Heartbeat-only tool: sends an unprompted message to the user.
// Factory-built per-tick with closures over per-tick state.
// NOT registered with Agent SDK — called manually by heartbeat handler.

import { z } from 'zod';
import { parseControlTokens, isNoReplyEnabled } from '../../adapters/split-response.js';

const inputSchema = z.object({
  text: z.string().min(10).max(500),
  channel: z.enum(['imessage', 'web']).default('imessage'),
  // Explicitly identifies which already-claimed commitments this message fulfills.
  // runHeartbeat validates ownership before invoking this side-effecting handler.
  followup_ids: z.array(z.number().int()).default([]),
});

export interface TickState {
  proactivesSent: number;
}

export interface SendProactiveOptions {
  userId: string;
  consentProactive: boolean;
  tickState: TickState;
  sendImessage: (msg: { to: string; text: string }) => Promise<void>;
  logAction: (action: Record<string, unknown>) => void;
}

const MAX_PROACTIVES_PER_TICK = 1;

export function createSendProactiveTool(opts: SendProactiveOptions) {
  return {
    name: 'send_proactive_message' as const,
    description:
      'Send an unprompted message to the user. Use sparingly: only when the user benefits clearly (followup reminder, event brief, anomaly check-in if opted-in). Include only the followup_ids explicitly fulfilled by this message; use [] for unrelated proactives. Max 1 per heartbeat tick.',
    inputSchema,
    async handler(input: z.infer<typeof inputSchema>) {
      const parsed = inputSchema.parse(input);
      if (!opts.consentProactive) {
        throw new Error('User has not granted consent for proactive messages.');
      }
      if (opts.tickState.proactivesSent >= MAX_PROACTIVES_PER_TICK) {
        throw new Error('Proactive rate limit (1 per tick) already reached.');
      }
      // The heartbeat inherits master.md, so when GEORGE_NOREPLY_ENABLED is on the
      // model can emit {{NO_REPLY}} into a proactive. Strip the token ALWAYS (a
      // literal marker must never reach a user) and, when the opt-out is enabled or
      // stripping left nothing to say, decline the send (don't count it against the
      // tick limit). The heartbeat already has heartbeat_ok for silence, so this is
      // a defensive backstop for the reactive-style token leaking into this sink.
      const { noReply, text: cleanText } = parseControlTokens(parsed.text);
      if ((isNoReplyEnabled() && noReply) || cleanText.length === 0) {
        opts.logAction({
          tool: 'send_proactive_message',
          suppressed: true,
          reason: noReply ? 'no_reply' : 'empty_after_strip',
        });
        return {
          content: [{ type: 'text' as const, text: 'Declined to send (NO_REPLY).' }],
        };
      }
      if (parsed.channel === 'imessage') {
        await opts.sendImessage({ to: opts.userId, text: cleanText });
      } else {
        throw new Error('Web channel not yet implemented; use imessage.');
      }
      opts.tickState.proactivesSent += 1;
      opts.logAction({ tool: 'send_proactive_message', channel: parsed.channel, length: cleanText.length });
      return {
        content: [
          { type: 'text' as const, text: `Sent: "${cleanText.slice(0, 80)}..."` },
        ],
      };
    },
  };
}
