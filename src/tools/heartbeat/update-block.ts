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
  // 'append' (preferred for adding a new fact) merges new_content into the block
  // without losing what's there; 'replace' overwrites the whole block (use only
  // to correct or prune). Defaults to 'replace' for backward compatibility.
  mode: z.enum(['replace', 'append']).optional().default('replace'),
});

export interface UpdateBlockOptions {
  userId: string;
  saveBlock: (userId: string, block: BlockName, content: string) => Promise<void>;
  // Safe accumulating write (dedupe + no clobber). When provided, mode:'append'
  // routes here; otherwise append falls back to saveBlock (full overwrite).
  appendToBlock?: (userId: string, block: BlockName, addition: string) => Promise<void>;
  logAction: (action: Record<string, unknown>) => void;
}

export function createUpdateBlockTool(opts: UpdateBlockOptions) {
  return {
    name: 'update_block' as const,
    description:
      'Update one of the 6 profile blocks (identity, academic, interests, relationships, state, george_notes). Heartbeat-only. To ADD a new fact, use mode:"append" with ONLY the new fact in new_content — existing content is preserved and de-duplicated. Use mode:"replace" with a full rewrite ONLY to correct or prune. Include a 1-2 sentence reason.',
    inputSchema,
    async handler(input: z.infer<typeof inputSchema>) {
      const parsed = inputSchema.parse(input);
      if (parsed.mode === 'append' && opts.appendToBlock) {
        await opts.appendToBlock(opts.userId, parsed.block_name, parsed.new_content);
      } else {
        await opts.saveBlock(opts.userId, parsed.block_name, parsed.new_content);
      }
      opts.logAction({
        tool: 'update_block',
        block_name: parsed.block_name,
        mode: parsed.mode,
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
