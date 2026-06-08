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
  // Zod v4 ships toJSONSchema() natively. Strip the $schema key so the
  // function-calling API only sees the plain JSON Schema object.
  const full = (schema as any).toJSONSchema() as Record<string, unknown>;
  const { $schema, ...rest } = full;
  return rest;
}
