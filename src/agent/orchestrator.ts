// src/agent/orchestrator.ts
// Orchestrator: entry point for all george conversations. Routes user messages to
// specialist sub-agents via the Agent SDK's description-based dispatch, or responds
// directly for small talk / refusal categories.
//
// Profile injection: buildOrchestratorPrompt(profile) appends a # USER PROFILE
// section when a Profile is supplied. Sub-agents defined in agents.config.ts
// build their prompts as ${MASTER_PROMPT}\n\n${SPECIALIZATION_PROMPT} at module
// load time, so they do NOT automatically inherit the user profile injected here.
// The orchestrator is expected to pass relevant profile context to sub-agents
// through the natural language prompt it crafts when invoking them. If a future
// slice needs sub-agents to receive the profile directly, agents.config will need
// to become a per-invocation factory that takes a profile argument.

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { MASTER_PROMPT, ORCHESTRATOR_PROMPT, SUB_AGENTS, ORCHESTRATOR_DIRECT_TOOLS } from './agents.config.js';
import { ALL_TOOLS } from '../tools/index.js';
import type { SessionStore } from './session-store.js';
import type { Profile, ProfileStore } from '../memory/profile.js';

// Register george's 23 tools as an in-process SDK MCP server so the model can
// actually CALL them. Without this, the orchestrator/sub-agents only had tool
// NAMES in their allowlists with no implementations behind them — every custom
// tool was uninvokable and george hedged instead of using a tool. SDK MCP tools
// are namespaced as `mcp__<serverName>__<toolName>`, so tool() names like
// `recommend_courses` become `mcp__george__recommend_courses` in the allowlists.
const MCP_SERVER_NAME = 'george';
const georgeToolServer = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: '1.0.0',
  tools: Object.values(ALL_TOOLS),
  alwaysLoad: true, // keep all tools in-prompt; don't defer behind tool search
});

// Map a bare tool name (as used in agents.config) to its namespaced MCP name.
const nsTool = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

export interface RunOrchestratorArgs {
  userId: string;
  channel: 'imessage' | 'web' | 'cron';
  text: string;
  sessionStore?: SessionStore;
  profileStore?: ProfileStore;
  mockMode?: boolean;
  maxTurns?: number;
}

// The 6 memory blocks rendered as a system-prompt section. Empty string when
// no profile, so callers can append unconditionally. Shared by the orchestrator
// AND the sub-agents so specialists (e.g. know-things for course recs) can
// personalize off the student's actual major/year/interests.
function buildUserProfileBlock(profile?: Profile | null): string {
  if (!profile) return '';
  const blocks = ['identity', 'academic', 'interests', 'relationships', 'state', 'george_notes'] as const;
  const sections = blocks.map((name) => {
    const content = profile[name];
    const label = name.toUpperCase().replace('_', ' ');
    return `## ${label}\n${content || '(empty)'}`;
  });
  return `# USER PROFILE\n\n${sections.join('\n\n')}`;
}

export function buildOrchestratorPrompt(profile?: Profile | null): string {
  const base = `${MASTER_PROMPT}\n\n${ORCHESTRATOR_PROMPT}`;
  const userProfileBlock = buildUserProfileBlock(profile);
  return userProfileBlock ? `${base}\n\n${userProfileBlock}` : base;
}

/**
 * Build the `agents` config for the Agent SDK.
 *
 * SDK shape: Record<string, AgentDefinition> where AgentDefinition.tools is
 * string[] (tool names, not tool objects). The SDK resolves the tool objects
 * internally — we just list the names.
 */
function buildAgentsConfig(
  profile?: Profile | null,
): Record<string, { description: string; prompt: string; tools: string[] }> {
  // Inject the user profile into each sub-agent so it doesn't have to be
  // re-stated through the dispatch prompt (it often wasn't). Now know-things
  // always knows the student's major/year/interests and can personalize.
  const userProfileBlock = buildUserProfileBlock(profile);
  const config: Record<string, { description: string; prompt: string; tools: string[] }> = {};
  for (const [name, def] of Object.entries(SUB_AGENTS)) {
    config[name] = {
      description: def.description,
      prompt: userProfileBlock ? `${def.prompt}\n\n${userProfileBlock}` : def.prompt,
      // Namespace each tool to its MCP name so the sub-agent can actually call
      // the registered implementation (inherits the parent's mcpServers).
      tools: def.tools.map(nsTool),
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
  // The `tools` option is a RESTRICTION allowlist (SDK: "to restrict which
  // tools are available, use the tools option"). Without the sub-agent
  // dispatch tool here, the orchestrator can only call its 2 direct tools and
  // the model NARRATES the dispatch as text ("Agent('know-things', ...)")
  // instead of actually invoking a sub-agent. The SDK names the dispatch tool
  // both "Task" and "Agent" — include both so whichever the runtime exposes
  // is permitted. The direct tools are namespaced to their MCP names.
  return ['Task', 'Agent', ...ORCHESTRATOR_DIRECT_TOOLS.map(nsTool)];
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

  // Load user profile early so it can be injected into the system prompt.
  // Silently falls back to no profile when profileStore is not provided.
  const profile = args.profileStore ? await args.profileStore.loadProfile(args.userId) : null;

  const systemPrompt = buildOrchestratorPrompt(profile);
  const agentsConfig = buildAgentsConfig(profile);
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
      // Register george's tools so the model can actually invoke them. Keyed
      // 'george' to match the mcp__george__* names in the allowlists above.
      mcpServers: { [MCP_SERVER_NAME]: georgeToolServer },
      tools: orchestratorTools,
      // Auto-approve every george tool + the sub-agent dispatch tools, so they
      // execute headlessly. Without this the SDK gates each call behind a
      // permission prompt that no one answers on a server → tool_result errors
      // ("you haven't granted it yet") and george hedges. `tools` (orchestrator)
      // and each sub-agent's tool list still gate WHICH agent may call WHAT.
      allowedTools: ['Task', 'Agent', ...Object.keys(ALL_TOOLS).map(nsTool)],
      agents: agentsConfig,
      maxTurns: args.maxTurns ?? 12,
      // CRITICAL: isolation mode. Without this, the SDK inherits the host's
      // ~/.claude/settings.json, project .claude/settings.json, MCP servers,
      // hooks, AND slash commands. A USC freshman texting "/cost" or "/model"
      // would get Claude Code's literal slash-command response, "/goal plz
      // fuck me" would invoke Claude Code's /goal handler. settingSources:[]
      // turns ALL of that off — george runs with only the tools we explicitly
      // list and the prompt we explicitly write.
      settingSources: [],
      // Session persistence is not needed — george is stateless at the SDK level.
      // Our SessionStore handles conversation memory via history injection above.
      persistSession: false,
    },
  })) {
    yield message as { type: string; text?: string };
  }
}
