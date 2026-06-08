// src/tools/heartbeat/update-block.ts
// Heartbeat-only tool: rewrites one of the 6 user profile blocks.
// Factory-built per-tick with closures over per-tick state.
// NOT registered with Agent SDK — called manually by heartbeat handler.

import { z } from 'zod';
import { BlockName, BLOCK_NAMES } from '../../memory/profile.js';

const inputSchema = z.object({
  block_name: z.enum(BLOCK_NAMES),
  new_content: z.string().min(1).max(2000),
  reason: z.string().min(5).max(500),
});

export interface UpdateBlockOptions {
  userId: string;
  saveBlock: (userId: string, block: BlockName, content: string) => Promise<void>;
  logAction: (action: Record<string, unknown>) => void;
}

export function createUpdateBlockTool(opts: UpdateBlockOptions) {
  return {
    name: 'update_block' as const,
    description:
      'Update one of the 6 profile blocks (identity, academic, interests, relationships, state, george_notes). Heartbeat-only. Provide a complete rewrite of the block (not append). Include a 1-2 sentence reason.',
    inputSchema,
    async handler(input: z.infer<typeof inputSchema>) {
      const parsed = inputSchema.parse(input);
      await opts.saveBlock(opts.userId, parsed.block_name, parsed.new_content);
      opts.logAction({
        tool: 'update_block',
        block_name: parsed.block_name,
        reason: parsed.reason,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated ${parsed.block_name}: ${parsed.reason}`,
          },
        ],
      };
    },
  };
}
