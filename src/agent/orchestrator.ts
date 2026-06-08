// src/agent/orchestrator.ts
// Orchestrator: entry point for all george conversations. Routes user messages to
// specialist sub-agents via the Agent SDK's description-based dispatch, or responds
// directly for small talk / refusal categories.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { MASTER_PROMPT, ORCHESTRATOR_PROMPT, SUB_AGENTS, ORCHESTRATOR_DIRECT_TOOLS } from './agents.config.js';
import type { SessionStore } from './session-store.js';

export interface RunOrchestratorArgs {
  userId: string;
  channel: 'imessage' | 'web' | 'cron';
  text: string;
  sessionStore?: SessionStore;
  mockMode?: boolean;
  maxTurns?: number;
}

export function buildOrchestratorPrompt(): string {
  return `${MASTER_PROMPT}\n\n${ORCHESTRATOR_PROMPT}`;
}

/**
 * Build the `agents` config for the Agent SDK.
 *
 * SDK shape: Record<string, AgentDefinition> where AgentDefinition.tools is
 * string[] (tool names, not tool objects). The SDK resolves the tool objects
 * internally — we just list the names.
 */
function buildAgentsConfig(): Record<string, { description: string; prompt: string; tools: string[] }> {
  const config: Record<string, { description: string; prompt: string; tools: string[] }> = {};
  for (const [name, def] of Object.entries(SUB_AGENTS)) {
    config[name] = {
      description: def.description,
      prompt: def.prompt,
      // tools is already string[] in AgentDefinition per SDK types
      tools: [...def.tools],
    };
  }
  return config;
}

/**
 * Build the tool names list for the orchestrator's own direct tools.
 *
 * SDK shape: options.tools is string[] | { type: 'preset'; preset: 'claude_code' }.
 * We pass just the names for the orchestrator's direct tools.
 */
function buildOrchestratorToolNames(): string[] {
  return [...ORCHESTRATOR_DIRECT_TOOLS];
}

/**
 * Build a conversation-history prefix from our custom SessionStore.
 *
 * The SDK's sessionStore option is a transcript-mirroring adapter (completely
 * different from our per-user Message[] store). We cannot pass our SessionStore
 * to query(). Instead, we load the recent conversation history before calling
 * query() and prepend it to the user's message as context so the orchestrator
 * has continuity.
 */
async function buildHistoryPrefix(sessionStore: SessionStore | undefined, userId: string): Promise<string> {
  if (!sessionStore) return '';

  const session = await sessionStore.load(userId);
  if (!session || session.messages.length === 0) return '';

  const historyLines = session.messages
    .slice(-10) // last 10 messages to stay within context budget
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n');

  return `<conversation_history>\n${historyLines}\n</conversation_history>\n\n`;
}

export async function* runOrchestrator(args: RunOrchestratorArgs): AsyncGenerator<{ type: string; text?: string }> {
  if (args.mockMode) {
    // For tests: return a synthetic response without calling the real LLM.
    if (args.text.toLowerCase().match(/doctor|sick|medical/)) {
      yield { type: 'text', text: 'sounds like Engemann Student Health Center can help. 213-740-9355.' };
      return;
    }
    yield { type: 'text', text: `[mock] received: ${args.text}` };
    return;
  }

  const systemPrompt = buildOrchestratorPrompt();
  const agentsConfig = buildAgentsConfig();
  const orchestratorTools = buildOrchestratorToolNames();

  // Load conversation history from our custom SessionStore and prepend as context.
  // The SDK's own sessionStore option mirrors transcripts to an external store —
  // not the same concept. We handle session state ourselves.
  const historyPrefix = await buildHistoryPrefix(args.sessionStore, args.userId);
  const promptWithHistory = `${historyPrefix}${args.text}`;

  for await (const message of query({
    prompt: promptWithHistory,
    options: {
      systemPrompt,
      tools: orchestratorTools,
      agents: agentsConfig,
      maxTurns: args.maxTurns ?? 12,
      // Session persistence is not needed — george is stateless at the SDK level.
      // Our SessionStore handles conversation memory via history injection above.
      persistSession: false,
    },
  })) {
    yield message as { type: string; text?: string };
  }
}
