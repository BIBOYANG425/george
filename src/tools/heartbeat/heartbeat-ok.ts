// src/tools/heartbeat/heartbeat-ok.ts
// Heartbeat-only tool: explicit no-op. The most common heartbeat outcome.
// Factory-built per-tick with closures over per-tick state.
// NOT registered with Agent SDK — called manually by heartbeat handler.

import { z } from 'zod';

export interface HeartbeatOkOptions {
  logAction: (action: Record<string, unknown>) => void;
}

export function createHeartbeatOkTool(opts: HeartbeatOkOptions) {
  return {
    name: 'heartbeat_ok' as const,
    description:
      'No action needed this tick. Preferred return when the user is fine and there is nothing meaningful to update, no proactive needed, no followup to schedule. This is the most common outcome.',
    inputSchema: z.object({}),
    async handler() {
      opts.logAction({ tool: 'heartbeat_ok' });
      return {
        content: [{ type: 'text' as const, text: 'HEARTBEAT_OK' }],
      };
    },
  };
}
