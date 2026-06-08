// src/tools/heartbeat/send-proactive-message.ts
// Heartbeat-only tool: sends an unprompted message to the user.
// Factory-built per-tick with closures over per-tick state.
// NOT registered with Agent SDK — called manually by heartbeat handler.

import { z } from 'zod';

const inputSchema = z.object({
  text: z.string().min(10).max(500),
  channel: z.enum(['imessage', 'web']).default('imessage'),
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
      'Send an unprompted message to the user. Use sparingly: only when the user benefits clearly (followup reminder, event brief, anomaly check-in if opted-in). Max 1 per heartbeat tick.',
    inputSchema,
    async handler(input: z.infer<typeof inputSchema>) {
      const parsed = inputSchema.parse(input);
      if (!opts.consentProactive) {
        throw new Error('User has not granted consent for proactive messages.');
      }
      if (opts.tickState.proactivesSent >= MAX_PROACTIVES_PER_TICK) {
        throw new Error('Proactive rate limit (1 per tick) already reached.');
      }
      if (parsed.channel === 'imessage') {
        await opts.sendImessage({ to: opts.userId, text: parsed.text });
      } else {
        throw new Error('Web channel not yet implemented; use imessage.');
      }
      opts.tickState.proactivesSent += 1;
      opts.logAction({ tool: 'send_proactive_message', channel: parsed.channel, length: parsed.text.length });
      return {
        content: [
          { type: 'text' as const, text: `Sent: "${parsed.text.slice(0, 80)}..."` },
        ],
      };
    },
  };
}
