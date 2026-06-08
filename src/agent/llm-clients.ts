// src/agent/llm-clients.ts
import { z } from 'zod';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface LLMResponse {
  toolCalls: ToolCall[];
  text?: string;
}

export interface LLMClient {
  call(args: {
    systemPrompt: string;
    userPrompt: string;
    tools: Array<{ name: string; description: string; inputSchema: z.ZodSchema }>;
    maxTokens?: number;
  }): Promise<LLMResponse>;
}

export function createDeepSeekClient(): LLMClient {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  return {
    async call({ systemPrompt, userPrompt, tools, maxTokens }) {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          tools: tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: zodToJsonSchema(t.inputSchema),
            },
          })),
          tool_choice: 'required',
          max_tokens: maxTokens ?? 800,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`DeepSeek API error ${res.status}: ${body}`);
      }
      const json = await res.json() as any;
      const message = json.choices?.[0]?.message;
      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc: any) => ({
        name: tc.function.name,
        input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments,
      }));
      return { toolCalls, text: message?.content ?? undefined };
    },
  };
}

function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  // Minimal Zod -> JSON Schema conversion for the limited shapes used in heartbeat tools.
  // For richer support, swap in `zod-to-json-schema` package.
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = zodFieldToJsonSchema(field);
      if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    return { type: 'object', properties, required };
  }
  return { type: 'object' };
}

function zodFieldToJsonSchema(field: z.ZodSchema): Record<string, unknown> {
  if (field instanceof z.ZodString) return { type: 'string' };
  if (field instanceof z.ZodNumber) return { type: 'number' };
  if (field instanceof z.ZodBoolean) return { type: 'boolean' };
  if (field instanceof z.ZodEnum) return { type: 'string', enum: (field as any)._def.values };
  if (field instanceof z.ZodDefault) return zodFieldToJsonSchema((field as any)._def.innerType);
  if (field instanceof z.ZodOptional) return zodFieldToJsonSchema((field as any)._def.innerType);
  return { type: 'string' };
}
