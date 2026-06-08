// src/tools/_wrap.ts
// Helper for converting existing tool handlers to Agent SDK tool() format.
//
// The Agent SDK's tool() accepts a ZodRawShape (an object whose values are
// Zod schema fields, e.g. { name: z.string(), age: z.number() }) rather than
// a top-level ZodSchema. InferShape<T> resolves each field's output type so
// the handler receives a plain typed object.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { AnyZodRawShape, InferShape } from '@anthropic-ai/claude-agent-sdk'

export interface WrappedToolInput<TShape extends AnyZodRawShape> {
  name: string
  description: string
  schema: TShape
  handler: (input: InferShape<TShape>) => Promise<unknown>
}

export function wrapTool<TShape extends AnyZodRawShape>(opts: WrappedToolInput<TShape>) {
  return tool(
    opts.name,
    opts.description,
    opts.schema,
    async (input: InferShape<TShape>, _extra: unknown) => {
      try {
        const result = await opts.handler(input)
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        return {
          content: [{ type: 'text' as const, text }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool ${opts.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )
}
