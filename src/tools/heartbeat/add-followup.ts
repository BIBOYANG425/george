// src/tools/heartbeat/add-followup.ts
// Heartbeat-only tool: schedules a future commitment for george to act on.
// Factory-built per-tick with closures over per-tick state.
// NOT registered with Agent SDK — called manually by heartbeat handler.

import { z } from 'zod';

const inputSchema = z.object({
  text: z.string().min(5).max(300),
  scheduled_for: z.string().datetime({ offset: true }),
});

export interface AddFollowupOptions {
  userId: string;
  insertFollowup: (row: { userId: string; content: string; scheduledFor: string }) => Promise<void>;
  logAction: (action: Record<string, unknown>) => void;
}

export function createAddFollowupTool(opts: AddFollowupOptions) {
  return {
    name: 'add_followup' as const,
    description:
      'Schedule a future commitment for george to remember and act on. Use when user mentions a future event (presentation, exam, decision) you should check on. scheduled_for must be in the future, ISO 8601 with timezone.',
    inputSchema,
    async handler(input: z.infer<typeof inputSchema>) {
      const parsed = inputSchema.parse(input);
      const when = new Date(parsed.scheduled_for);
      if (when.getTime() <= Date.now()) {
        throw new Error('scheduled_for must be in the future.');
      }
      await opts.insertFollowup({
        userId: opts.userId,
        content: parsed.text,
        scheduledFor: parsed.scheduled_for,
      });
      opts.logAction({ tool: 'add_followup', scheduled_for: parsed.scheduled_for });
      return {
        content: [{ type: 'text' as const, text: `Followup scheduled for ${parsed.scheduled_for}: ${parsed.text}` }],
      };
    },
  };
}
