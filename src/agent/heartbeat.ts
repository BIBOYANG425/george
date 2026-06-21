// src/agent/heartbeat.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileStore, BlockName, BLOCK_NAMES, MAX_BLOCK_CHARS, type Profile } from '../memory/profile.js';
import { InstructionsStore } from '../memory/instructions.js';
import { LLMClient } from './llm-clients.js';
import { callLightweightLLM } from './llm-providers.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { createUpdateBlockTool } from '../tools/heartbeat/update-block.js';
import { createSendProactiveTool } from '../tools/heartbeat/send-proactive-message.js';
import { createAddFollowupTool } from '../tools/heartbeat/add-followup.js';
import { createHeartbeatOkTool } from '../tools/heartbeat/heartbeat-ok.js';
import { applyNoReplyGate } from './noreply-gate.js';
import {
  extractOpenThreads,
  unraisedThreads,
  renderGroundedProactiveNote,
  recordRaisedThread,
  loadRaisedThreads,
  isGroundedProactiveEnabled,
  GROUNDED_PROACTIVE_GUIDANCE,
  type OpenThread,
  type RaisedThreadDB,
} from './grounded-proactive.js';

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
  // Table-backed raised-thread ledger (proactive_raised_threads). Injected so it
  // unit-tests with a fake. Production passes createSupabaseRaisedThreadDB().
  raisedThreadDb: RaisedThreadDB;
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
const MASTER_PROMPT = applyNoReplyGate(
  fs.readFileSync(path.resolve(__dirname, '../../prompts/master.md'), 'utf-8')
);

const RECENT_MESSAGES_LIMIT = 10;
const MAX_TOKENS = 800;

// ── Memory compaction (P1 memory-consolidation) ───────────────────────────────
// The atomic append RPC (Task 4) never slices an over-cap block; instead it sets
// user_profiles.compaction_due = now(). This is where the heartbeat acts on that
// marker: when it is set, condense/dedupe each over-cap block back under the cap
// with the lightweight LLM, then clear the marker. This replaces the old silent
// truncation with real compaction (no data loss).

// Condenses one block's content. The block name is passed so a summarizer can
// vary its prompt per block if needed. Returns the condensed content.
export type BlockSummarizer = (block: BlockName, content: string) => Promise<string>;

// Pure-ish, dependency-injected so it unit-tests without the whole tick. Only
// touches blocks > MAX_BLOCK_CHARS, only writes a condensed block when it is
// non-empty AND strictly shorter than the original (never grow, never blank a
// block), and only clears compaction_due when the marker was set.
export async function compactProfileIfDue(
  store: {
    saveBlock(u: string, b: BlockName, c: string): Promise<void>;
    clearCompactionDue(u: string): Promise<void>;
  },
  userId: string,
  profile: Profile,
  summarize: BlockSummarizer,
): Promise<void> {
  if (!profile.compaction_due) return;
  for (const block of BLOCK_NAMES) {
    const content = profile[block] ?? '';
    if (content.length <= MAX_BLOCK_CHARS) continue;
    const condensed = (await summarize(block, content)).trim();
    if (condensed && condensed.length < content.length) {
      await store.saveBlock(userId, block, condensed);
      log('info', 'memory_compacted', { userId, block, before: content.length, after: condensed.length });
    }
  }
  await store.clearCompactionDue(userId);
}

// Real summarizer for production: condense + dedupe one over-cap block with the
// SMART tier (same tier the relationship evaluator uses — this is a judgment
// task, preserve every distinct fact). System prompt drops only exact/near
// duplicates and filler, keeps one-fact-per-line, outputs under the cap.
const COMPACT_SYSTEM = [
  'You compact a memory block for an AI companion.',
  'Dedupe and condense the lines below, preserving every DISTINCT durable fact, drop only exact/near duplicates and filler.',
  'Keep the one-fact-per-line format.',
  `Output ONLY the condensed block, under ${MAX_BLOCK_CHARS} characters.`,
].join(' ');

async function realSummarize(_block: BlockName, content: string): Promise<string> {
  return callLightweightLLM(
    [
      { role: 'system', content: COMPACT_SYSTEM },
      { role: 'user', content },
    ],
    { maxTokens: 1500, model: config.models.smart },
  );
}

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

    // The grounded-proactive guidance is part of the feature's prompt footprint,
    // so it is appended ONLY when the flag is on. With the flag off the system
    // prompt is byte-for-byte the pre-P4 prompt (master + heartbeat).
    const systemPrompt = isGroundedProactiveEnabled()
      ? `${MASTER_PROMPT}\n\n${HEARTBEAT_PROMPT}\n\n${GROUNDED_PROACTIVE_GUIDANCE}`
      : `${MASTER_PROMPT}\n\n${HEARTBEAT_PROMPT}`;
    const profileBlock = deps.profileStore.renderForPrompt(profile);

    // P4 — grounded proactive (DEFAULT-OFF). When enabled, mine the already-loaded
    // recent messages for a concrete open thread george can ground a proactive on,
    // skipping any thread already raised. The raised-thread ledger lives in the
    // proactive_raised_threads table (the only source). The rendered note is
    // append-or-empty-string, so when the flag is off — or there is no fresh
    // thread — the user prompt is byte-for-byte identical to before.
    let groundableThreads: OpenThread[] = [];
    let groundedNote = '';
    if (isGroundedProactiveEnabled()) {
      const raised = await loadRaisedThreads(deps.raisedThreadDb, userId);
      groundableThreads = unraisedThreads(extractOpenThreads(messages), raised);
      groundedNote = renderGroundedProactiveNote(groundableThreads);
    }

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
      ...(groundedNote ? [groundedNote] : []),
      `\nReview this user's state. Choose exactly ONE tool to call.`,
    ].join('\n\n');

    const tools = [
      createUpdateBlockTool({
        userId,
        saveBlock: (uid: string, block: BlockName, content: string) =>
          deps.profileStore.saveBlock(uid, block, content),
        appendToBlock: (uid: string, block: BlockName, addition: string) =>
          deps.profileStore.appendToBlock(uid, block, addition),
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
      else if (call.name === 'send_proactive_message') {
        outcome = 'proactive_send';
        // P4 — mark the grounded thread raised so it is not raised again next
        // tick. The ledger now writes to the proactive_raised_threads table;
        // recordRaisedThread is idempotent (unique (user_id, thread) index), so
        // this is a no-op if already ledgered. Only the top unraised thread is
        // marked (one proactive grounds on one thread per tick). Guarded so it is
        // inert when the flag is off.
        if (isGroundedProactiveEnabled() && groundableThreads.length > 0) {
          const raised = groundableThreads[0];
          await recordRaisedThread(deps.raisedThreadDb, userId, raised.key);
          logAction({ tool: 'mark_thread_raised', threadKey: raised.key });
        }
      } else if (call.name === 'add_followup') outcome = 'followup_scheduled';
      else outcome = 'ok';
    }

    await deps.updateLastHeartbeatAt(userId);

    // P1 memory-consolidation: if the atomic append RPC flagged an over-cap block
    // this cycle (compaction_due set), condense it back under the cap with the
    // lightweight LLM and clear the marker. Reuses the profile already loaded for
    // this tick (no reload). Isolated so a compaction failure never fails the tick
    // or flips the outcome — the marker stays set and the next tick retries.
    if (profile.compaction_due) {
      try {
        await compactProfileIfDue(deps.profileStore, userId, profile, realSummarize);
      } catch (compactErr) {
        log('warn', 'memory_compaction_failed', {
          userId,
          error: compactErr instanceof Error ? compactErr.message : String(compactErr),
        });
      }
    }
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
