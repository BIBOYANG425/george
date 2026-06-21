// src/agent/heartbeat.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileStore, BlockName, BLOCK_NAMES, MAX_BLOCK_CHARS, type Profile } from '../memory/profile.js';
import type { ObservationDB, UnconsolidatedObservation } from '../memory/observations.js';
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
import {
  isMemoryProactiveEnabled,
  resolveMemoryProactiveMinSalience,
  selectMemoryCandidates,
  renderMemoryProactiveNote,
  MEMORY_PROACTIVE_GUIDANCE,
  MEMORY_PROACTIVE_LOAD_LIMIT,
  type MemoryCandidate,
} from './memory-proactive.js';

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
  // P6 observational-memory — observation log seam for the Reflector pass. Optional
  // so existing callers/tests compile; the Reflector only runs when
  // GEORGE_REFLECT_ENABLED is on AND this dep is provided. Production passes
  // createSupabaseObservationDB().
  observationDB?: ObservationDB;
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
// non-empty, strictly shorter than the original, AND back under the cap (never
// grow, never blank a block, never hand saveBlock content it would reject), and
// only clears compaction_due when the marker was set. If the summarizer can't
// get a block back under the cap we log and move on rather than throw — clearing
// the marker so the tick doesn't re-summarize the same block forever; the next
// append re-flags it via the RPC.
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
    if (condensed && condensed.length < content.length && condensed.length <= MAX_BLOCK_CHARS) {
      await store.saveBlock(userId, block, condensed);
      log('info', 'memory_compacted', { userId, block, before: content.length, after: condensed.length });
    } else if (condensed.length > MAX_BLOCK_CHARS) {
      log('warn', 'memory_compaction_over_cap', { userId, block, before: content.length, after: condensed.length });
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

// ── Reflector (P6 observational-memory) ────────────────────────────────────────
// A heartbeat pass that periodically folds DURABLE/recurring observations from the
// user_observations log into the right long-term profile block(s), then prunes the
// log. Runs alongside compaction, gated by GEORGE_REFLECT_ENABLED (default OFF →
// the dep is never even touched; see runHeartbeat). george_notes is a pure
// scratchpad and is excluded as a fold target; observations fold only into
// identity|academic|interests|relationships|state.

export function isReflectEnabled(): boolean {
  return process.env.GEORGE_REFLECT_ENABLED === 'true';
}

// Parse an int env var, falling back to `fallback` on missing / NaN. Mirrors the
// finite-checked parseIntEnv in recall.ts so the Reflector reads RECALL_MIN_SALIENCE
// the same way Recall does — a valid 0 is honored rather than silently coerced to
// the default by the old `parseInt(...) || DEFAULT` idiom.
function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// Valid fold targets: every BLOCK_NAME except the george_notes scratchpad.
const REFLECT_TARGET_BLOCKS = new Set<BlockName>(
  BLOCK_NAMES.filter((b) => b !== 'george_notes'),
);

// Reuse the recall feature's salience floor + default so the Reflector and Recall
// see the same "worth keeping" bar (RECALL_MIN_SALIENCE, default 2).
const REFLECT_MIN_SALIENCE_DEFAULT = 2;
const REFLECT_LOAD_LIMIT = 50;
const REFLECT_PRUNE_DAYS_DEFAULT = 30;

// Given recent observations, decide which durable notes to fold into which block.
// Dependency-injected so reflectObservations unit-tests without a real LLM, mirroring
// how compactProfileIfDue takes an injected BlockSummarizer.
export type ObservationReflector = (
  observations: UnconsolidatedObservation[],
) => Promise<Array<{ block: BlockName; text: string }>>;

// Fold durable observations into profile blocks, mark them consolidated, prune the
// log. Fail-safe: any error is logged and swallowed so the heartbeat tick continues
// and rows are left un-consolidated for the next tick.
export async function reflectObservations(
  store: { appendToBlock(u: string, b: BlockName, c: string): Promise<void> },
  observationDB: Pick<ObservationDB, 'loadUnconsolidated' | 'markConsolidated' | 'prune'>,
  userId: string,
  reflect: ObservationReflector,
): Promise<void> {
  try {
    const minSalience = parseIntEnv(process.env.RECALL_MIN_SALIENCE, REFLECT_MIN_SALIENCE_DEFAULT);
    const pruneDays = parseIntEnv(process.env.REFLECT_PRUNE_DAYS, REFLECT_PRUNE_DAYS_DEFAULT);

    const obs = await observationDB.loadUnconsolidated(userId, minSalience, REFLECT_LOAD_LIMIT);

    if (obs.length === 0) {
      // Nothing fresh to reflect on, but still age out old/consolidated rows.
      await observationDB.prune(userId, pruneDays);
      return;
    }

    const appends = await reflect(obs);
    for (const a of appends) {
      const text = (a?.text ?? '').trim();
      if (!text) continue;
      if (!REFLECT_TARGET_BLOCKS.has(a.block as BlockName)) continue;
      await store.appendToBlock(userId, a.block, text);
    }

    // Mark ALL loaded observations consolidated — they have been reflected on
    // whether or not they produced an append. This prevents re-loading them forever
    // and lets them age out via prune.
    await observationDB.markConsolidated(obs.map((o) => o.id));

    await observationDB.prune(userId, pruneDays);
  } catch (err) {
    log('warn', 'reflect_failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Production reflector: fold durable observations into blocks with the lightweight
// LLM (JSON mode, like realSummarize). Parses tolerantly (first-{ … last-}) and
// drops any entry whose block name isn't a valid fold target.
const REFLECT_SYSTEM = [
  "You consolidate a student's recent observations into their long-term profile.",
  'Given observations (content/kind/salience), output STRICT JSON',
  '{"appends":[{"block":"<identity|academic|interests|relationships|state>","text":"<short third-person durable note>"}]}',
  '— fold only DURABLE, recurring, or significant patterns; skip transient one-offs; never invent;',
  '{"appends":[]} if nothing durable.',
].join(' ');

function parseReflect(raw: string): Array<{ block: BlockName; text: string }> {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return [];
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      appends?: Array<{ block?: unknown; text?: unknown }>;
    };
    const appends = Array.isArray(obj.appends) ? obj.appends : [];
    const out: Array<{ block: BlockName; text: string }> = [];
    for (const a of appends) {
      const block = a?.block;
      const text = typeof a?.text === 'string' ? a.text : '';
      if (typeof block === 'string' && REFLECT_TARGET_BLOCKS.has(block as BlockName) && text.trim()) {
        out.push({ block: block as BlockName, text });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function realReflect(
  observations: UnconsolidatedObservation[],
): Promise<Array<{ block: BlockName; text: string }>> {
  const userContent = observations
    .map((o) => `- (${o.kind ?? 'note'}, salience ${o.salience}) ${o.content}`)
    .join('\n');
  const raw = await callLightweightLLM(
    [
      { role: 'system', content: REFLECT_SYSTEM },
      { role: 'user', content: userContent },
    ],
    { maxTokens: 400, jsonMode: true },
  );
  return parseReflect(raw);
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
    // prompt is byte-for-byte the pre-P4 prompt (master + heartbeat). The P6
    // memory-grounding guidance is an INDEPENDENT additive source behind its own
    // flag — appended only when GEORGE_MEMORY_PROACTIVE_ENABLED is on, so with both
    // flags off the system prompt is byte-for-byte unchanged, and the two can be
    // enabled independently.
    let systemPrompt = `${MASTER_PROMPT}\n\n${HEARTBEAT_PROMPT}`;
    if (isGroundedProactiveEnabled()) {
      systemPrompt = `${systemPrompt}\n\n${GROUNDED_PROACTIVE_GUIDANCE}`;
    }
    if (isMemoryProactiveEnabled()) {
      systemPrompt = `${systemPrompt}\n\n${MEMORY_PROACTIVE_GUIDANCE}`;
    }
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

    // P6 (post-MVP) — proactive memory-grounding (DEFAULT-OFF, independent flag).
    // When enabled AND the observationDB seam is wired, load recent SALIENT
    // observations the student told George (higher salience bar than reactive
    // recall, default 3), drop any already raised proactively (dedup keys
    // `mem:<id>` in the SAME proactive_raised_threads table — no new migration),
    // and surface the top few as candidate check-in material. ADDITIVE to the
    // open-thread grounding above: a separate prompt section, a separate flag. The
    // rendered note is append-or-empty-string, so when the flag is off — or the
    // dep is absent, or there is nothing salient/unraised — the user prompt is
    // byte-for-byte identical to before. Fail-safe: a load error never fails the
    // tick; we log and proceed with no memory grounding.
    let memoryCandidates: MemoryCandidate[] = [];
    let memoryNote = '';
    if (isMemoryProactiveEnabled() && deps.observationDB) {
      try {
        const [raised, observations] = await Promise.all([
          loadRaisedThreads(deps.raisedThreadDb, userId),
          deps.observationDB.loadUnconsolidated(
            userId,
            resolveMemoryProactiveMinSalience(),
            MEMORY_PROACTIVE_LOAD_LIMIT,
          ),
        ]);
        memoryCandidates = selectMemoryCandidates(observations, raised);
        memoryNote = renderMemoryProactiveNote(memoryCandidates);
      } catch (err) {
        log('warn', 'memory_proactive_load_failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
      ...(memoryNote ? [memoryNote] : []),
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
        // P6 — record the surfaced MEMORY candidates as raised so a remembered
        // observation is never re-pinged. The tool result does not tell us WHICH
        // memory (if any) the model grounded on, so — conservatively, and matching
        // how the open-thread path records-on-send — we ledger ALL surfaced
        // candidates once any proactive is sent this tick. recordRaisedThread is
        // idempotent (unique (user_id, thread) index). Keys are `mem:<id>`, disjoint
        // from open-thread gist-slug keys, so the two sources share the table
        // without collision. Guarded so it is inert when the memory flag is off.
        if (isMemoryProactiveEnabled() && memoryCandidates.length > 0) {
          for (const c of memoryCandidates) {
            await recordRaisedThread(deps.raisedThreadDb, userId, c.key);
          }
          logAction({
            tool: 'mark_memory_raised',
            memoryKeys: memoryCandidates.map((c) => c.key),
          });
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

    // P6 observational-memory: fold durable observations into the profile and prune
    // the observation log. DEFAULT-OFF — gated by GEORGE_REFLECT_ENABLED, and only
    // runs when the observationDB seam is wired. reflectObservations is itself
    // fail-safe (logs + swallows), so it never fails the tick.
    if (isReflectEnabled() && deps.observationDB) {
      await reflectObservations(deps.profileStore, deps.observationDB, userId, realReflect);
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
