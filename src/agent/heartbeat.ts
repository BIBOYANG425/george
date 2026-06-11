// src/agent/heartbeat.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileStore, BlockName } from '../memory/profile.js';
import { InstructionsStore } from '../memory/instructions.js';
import { LLMClient } from './llm-clients.js';
import { createUpdateBlockTool } from '../tools/heartbeat/update-block.js';
import { createSendProactiveTool } from '../tools/heartbeat/send-proactive-message.js';
import { createAddFollowupTool } from '../tools/heartbeat/add-followup.js';
import { createHeartbeatOkTool } from '../tools/heartbeat/heartbeat-ok.js';

export interface HeartbeatConfig {
  cadence: string;
  active_hours_start: string;
  active_hours_end: string;
  timezone: string;
  paused: boolean;
  consent_proactive_messages: boolean;
  consent_anomaly_checkin: boolean;
  last_heartbeat_at: string | null;
}

export interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface FollowupRow {
  id: number;
  content: string;
  scheduled_for: string;
}

export interface HeartbeatLogEntry {
  user_id: string;
  fired_at: string;
  duration_ms: number;
  outcome: 'ok' | 'block_update' | 'proactive_send' | 'followup_scheduled' | 'error';
  actions: Record<string, unknown>[];
  error_message: string | null;
}

export interface HeartbeatDeps {
  profileStore: ProfileStore;
  instructionsStore: InstructionsStore;
  loadConfig: (userId: string) => Promise<HeartbeatConfig | null>;
  loadRecentMessages: (userId: string, limit: number) => Promise<MessageRow[]>;
  loadDueFollowups: (userId: string) => Promise<FollowupRow[]>;
  sendImessage: (msg: { to: string; text: string }) => Promise<void>;
  insertFollowup: (row: { userId: string; content: string; scheduledFor: string }) => Promise<void>;
  writeLog: (entry: HeartbeatLogEntry) => Promise<void>;
  updateLastHeartbeatAt: (userId: string) => Promise<void>;
  callLLM: LLMClient['call'];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_PROMPT = fs.readFileSync(
  path.resolve(__dirname, '../../prompts/heartbeat.md'),
  'utf-8'
);
const MASTER_PROMPT = fs.readFileSync(
  path.resolve(__dirname, '../../prompts/master.md'),
  'utf-8'
);

const RECENT_MESSAGES_LIMIT = 10;
const MAX_TOKENS = 800;

export async function runHeartbeat(userId: string, deps: HeartbeatDeps): Promise<void> {
  const startedAt = Date.now();
  const firedAt = new Date().toISOString();
  const actions: Record<string, unknown>[] = [];
  const tickState = { proactivesSent: 0 };
  let outcome: HeartbeatLogEntry['outcome'] = 'ok';
  let errorMessage: string | null = null;

  const logAction = (action: Record<string, unknown>) => {
    actions.push(action);
  };

  try {
    const config = await deps.loadConfig(userId);
    if (!config) throw new Error(`No heartbeat config for ${userId}`);

    const [profile, instructions, messages, dueFollowups] = await Promise.all([
      deps.profileStore.loadProfile(userId),
      deps.instructionsStore.load(userId),
      deps.loadRecentMessages(userId, RECENT_MESSAGES_LIMIT),
      deps.loadDueFollowups(userId),
    ]);

    const systemPrompt = `${MASTER_PROMPT}\n\n${HEARTBEAT_PROMPT}`;
    const profileBlock = deps.profileStore.renderForPrompt(profile);
    const userPrompt = [
      profileBlock,
      `# STANDING INSTRUCTIONS\n${instructions || '(none)'}`,
      `# RECENT CONTEXT (last ${messages.length} messages)\n${
        messages.map((m) => `${m.role}: ${m.content}`).join('\n') || '(none)'
      }`,
      `# PENDING FOLLOWUPS DUE NOW\n${
        dueFollowups.length
          ? dueFollowups.map((f) => `- (${f.scheduled_for}) ${f.content}`).join('\n')
          : '(none)'
      }`,
      `\nReview this user's state. Choose exactly ONE tool to call.`,
    ].join('\n\n');

    const tools = [
      createUpdateBlockTool({
        userId,
        saveBlock: (uid: string, block: BlockName, content: string) =>
          deps.profileStore.saveBlock(uid, block, content),
        logAction,
      }),
      createSendProactiveTool({
        userId,
        consentProactive: config.consent_proactive_messages,
        tickState,
        sendImessage: deps.sendImessage,
        logAction,
      }),
      createAddFollowupTool({
        userId,
        insertFollowup: deps.insertFollowup,
        logAction,
      }),
      createHeartbeatOkTool({ logAction }),
    ];

    const response = await deps.callLLM({
      systemPrompt,
      userPrompt,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      maxTokens: MAX_TOKENS,
    });

    for (const call of response.toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${call.name}`);
      }
      await tool.handler(call.input as any);
      if (call.name === 'update_block') outcome = 'block_update';
      else if (call.name === 'send_proactive_message') outcome = 'proactive_send';
      else if (call.name === 'add_followup') outcome = 'followup_scheduled';
      else outcome = 'ok';
    }

    await deps.updateLastHeartbeatAt(userId);
  } catch (err) {
    outcome = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    await deps.writeLog({
      user_id: userId,
      fired_at: firedAt,
      duration_ms: Date.now() - startedAt,
      outcome,
      actions,
      error_message: errorMessage,
    });
  }
}
