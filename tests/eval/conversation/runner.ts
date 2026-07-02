// tests/eval/conversation/runner.ts
//
// runScenario(scenario, flagConfig): drives the REAL orchestrator over one
// scenario under one flag arm and returns a TurnRecord. Mirrors how src/index.ts
// consumes runOrchestrator events (result-event first, assistant-text fallback,
// telemetry capture) AND replicates the DOWNSTREAM {{NO_REPLY}} suppression that
// lives in src/adapters/split-response.ts + src/index.ts (NOT inside the
// orchestrator) so the harness sees the real suppressed/sent outcome (must-fix c).
//
// Env discipline: snapshot the per-run flags, set them, restore in a finally so
// arms never leak flag state into each other. Path flags (SINGLE_AGENT,
// GEORGE_TRUNK_HYBRID, KIMI_API_KEY) are PINNED by the caller's FlagConfig so the
// A/B varies only the one flag under test and the generation path is held
// constant (must-fix f: KIMI_API_KEY is pinned as a path flag).
//
// channel:'web' is deliberate — resolveStudentId is skipped (no live Supabase
// student row) and the imessage-only paths stay out.
//
// Spec: docs/superpowers/specs/2026-06-20-george-eval-harness-design.md
// Header last reviewed: 2026-06-19

import { runOrchestrator } from '../../../src/agent/orchestrator.js';
import { createInMemorySessionStore } from '../../../src/agent/session-store.js';
import type { SessionStore, TurnTelemetry } from '../../../src/agent/session-store.js';
import { ProfileStore, EMPTY_PROFILE } from '../../../src/memory/profile.js';
import type { Profile } from '../../../src/memory/profile.js';
import { createInMemoryCache } from '../../../src/memory/kv-cache.js';
import { parseControlTokens } from '../../../src/adapters/split-response.js';
import type { FlagConfig, Scenario, TurnRecord } from './types.js';

// Generous per-turn timeout — a real multi-agent turn is 5-50s; the test wrapper
// sets vitest's own timeout. This is the runner's internal hard cap so a wedged
// turn is recorded as an error arm rather than hanging the suite.
const RUNNER_DEADLINE_MS = 90_000;

// Build a mock ProfileStore seeded with scenario.profile so onboarding-gated
// scenarios get a complete profile (same minimal-deps pattern heartbeat-quality
// already uses: ProfileStore({loadRow, upsertBlock}, createInMemoryCache())).
function buildMockProfileStore(userId: string, partial?: Partial<Profile>): ProfileStore | undefined {
  if (!partial) return undefined;
  const row: Record<string, string> = { ...EMPTY_PROFILE, ...partial };
  const rows = new Map<string, Record<string, string>>([[userId, row]]);
  const cache = createInMemoryCache();
  return new ProfileStore(
    {
      async loadRow(uid) {
        return rows.get(uid) ?? null;
      },
      async upsertBlock(uid, block, content) {
        const r = rows.get(uid) ?? { ...EMPTY_PROFILE };
        r[block] = content;
        rows.set(uid, r);
      },
    },
    cache,
  );
}

// Seed prior history into the in-memory SessionStore. The in-memory save()
// REPLACES the session, so every prior turn must go in ONE save call. The
// trailing user turn is the one george answers and is NOT seeded (it is passed
// as `text`); only the turns BEFORE it become <conversation_history>.
async function seedHistory(store: SessionStore, userId: string, scenario: Scenario): Promise<string> {
  // Find the index of the trailing user turn.
  let trailingIdx = -1;
  for (let i = scenario.turns.length - 1; i >= 0; i--) {
    if (scenario.turns[i].role === 'user') {
      trailingIdx = i;
      break;
    }
  }
  const trailingText = trailingIdx >= 0 ? scenario.turns[trailingIdx].content : '';
  const prior = scenario.turns.slice(0, trailingIdx);
  if (prior.length > 0) {
    await store.save(userId, {
      sessionId: userId,
      messages: prior.map((t) => ({ role: t.role, content: t.content })),
      systemContext: {},
    });
  }
  return trailingText;
}

// Replicate src/index.ts reply extraction: result-event wins; else first
// assistant text block. Capture telemetry separately.
interface DriveResult {
  rawReply: string;
  telemetry?: TurnTelemetry;
}

export async function driveOrchestrator(args: {
  userId: string;
  text: string;
  sessionStore: SessionStore;
  profileStore?: ProfileStore;
  mockMode: boolean;
}): Promise<DriveResult> {
  let rawReply = '';
  let telemetry: TurnTelemetry | undefined;

  const gen = runOrchestrator({
    userId: args.userId,
    channel: 'web',
    text: args.text,
    sessionStore: args.sessionStore,
    profileStore: args.profileStore,
    mockMode: args.mockMode,
  });

  for await (const event of gen) {
    const e = event as {
      type?: string;
      result?: string;
      text?: string;
      telemetry?: TurnTelemetry;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (e.type === 'telemetry') {
      telemetry = e.telemetry;
    } else if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
      // result event wins (gate/fast paths emit {type:'result', result}; the
      // full-agent path yields the SDK result message whose `result` field is
      // the model's final text — exactly what index.ts reads).
      rawReply = e.result;
    } else if (e.type === 'text' && typeof e.text === 'string' && rawReply === '') {
      // mockMode emits {type:'text', text}; index.ts has no special case for it
      // but the mock smoke path needs SOMETHING captured.
      rawReply = e.text;
    } else if (e.type === 'assistant' && e.message?.content && rawReply === '') {
      const text = e.message.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (text) rawReply = text;
    }
  }

  return { rawReply, telemetry };
}

// Positive flag-activation check (must-fix g): for an ON-arm flag-target
// scenario, return whether the flag observably activated. Because path flags are
// pinned and the cadence-gated flags (RELATIONSHIP_EVAL, WORLD_STATE) only fire
// past a threshold, a null OFF-vs-ON delta with activation=false means "scenario
// never tripped the flag", not "flag did nothing".
//
// The check is observable-behavior based, keyed to each flag's tell:
//  - GEORGE_NOREPLY_ENABLED: ON activated iff the raw reply is the token (the
//    flag's whole job is to let the model emit {{NO_REPLY}}).
//  - WORLD_STATE_ENABLED / GEORGE_RELATIONSHIP_EVAL_ENABLED: the prompt overlay
//    is internal; we approximate activation as "the ON reply differs from the
//    OFF reply" which the caller computes (passed in as `differsFromOff`). Here
//    we report the NOREPLY case deterministically and defer the rest.
function detectFlagActivation(
  scenario: Scenario,
  flagConfig: FlagConfig,
  rawReply: string,
): boolean | undefined {
  if (!scenario.flagsUnderTest || scenario.flagsUnderTest.length === 0) return undefined;
  // Only meaningful on the arm where the flag is turned ON.
  const isOnArm = scenario.flagsUnderTest.some((f) => flagConfig.flags[f] === 'true');
  if (!isOnArm) return undefined;
  if (scenario.flagsUnderTest.includes('GEORGE_NOREPLY_ENABLED')) {
    // Observable: the model emitted the token (the flag's marker behavior).
    return rawReply.trim() === '{{NO_REPLY}}';
  }
  // For cadence/overlay flags the activation is asserted by the caller against
  // the OFF baseline (differs-from-off). Leave undefined here; report.ts treats
  // undefined-on-ON-arm as "not separately verified".
  return undefined;
}

export async function runScenario(scenario: Scenario, flagConfig: FlagConfig): Promise<TurnRecord> {
  const userId = `eval-${scenario.id}-${flagConfig.name}`;

  // Snapshot every env var the FlagConfig will touch, set them, restore in
  // finally. Same save/restore discipline the flag unit tests use.
  const touchedKeys = Object.keys(flagConfig.flags);
  const snapshot = new Map<string, string | undefined>();
  for (const k of touchedKeys) snapshot.set(k, process.env[k]);

  try {
    for (const [k, v] of Object.entries(flagConfig.flags)) {
      process.env[k] = v;
    }

    const sessionStore = createInMemorySessionStore();
    const trailingText = await seedHistory(sessionStore, userId, scenario);
    const profileStore = buildMockProfileStore(userId, scenario.profile);

    const result = await Promise.race([
      driveOrchestrator({ userId, text: trailingText, sessionStore, profileStore, mockMode: false }),
      new Promise<DriveResult>((_, reject) =>
        setTimeout(() => reject(new Error('runner_deadline_exceeded')), RUNNER_DEADLINE_MS),
      ),
    ]);

    const rawReply = result.rawReply;
    const telemetry = result.telemetry;
    const fastPath = telemetry?.outcome === 'fast_path';

    // Replicate downstream {{NO_REPLY}} suppression. src/index.ts gates this on
    // isNoReplyEnabled() reading GEORGE_NOREPLY_ENABLED — which is exactly the
    // flag we just set in process.env for this arm — so the harness honors the
    // SAME suppression the live adapter would (must-fix c).
    const noReplyEnabled = process.env.GEORGE_NOREPLY_ENABLED === 'true';
    let reply = rawReply;
    let suppressed = false;
    if (noReplyEnabled) {
      const parsed = parseControlTokens(rawReply);
      if (parsed.noReply) {
        suppressed = true;
        reply = '';
      } else {
        reply = parsed.text;
      }
    } else {
      // Flag OFF: token is still stripped from outgoing text (never suppresses).
      reply = parseControlTokens(rawReply).text;
    }

    return {
      scenarioId: scenario.id,
      flagConfigName: flagConfig.name,
      reply,
      rawReply,
      suppressed,
      tools: telemetry?.tools ?? [],
      costUsd: telemetry?.costUsd,
      outcome: telemetry?.outcome,
      durationMs: telemetry?.durationMs,
      fastPath,
      flagActivated: detectFlagActivation(scenario, flagConfig, rawReply),
    };
  } catch (err) {
    // A failed turn is recorded as an error arm, never silently dropped.
    return {
      scenarioId: scenario.id,
      flagConfigName: flagConfig.name,
      reply: '',
      rawReply: '',
      suppressed: false,
      tools: [],
      fastPath: false,
      error: (err as Error).message,
    };
  } finally {
    // Restore every touched env var (delete the ones that were unset).
    for (const [k, v] of snapshot.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A cheap mockMode:true smoke variant: asserts the harness PLUMBING (history
// seeding, env flag set/restore, event capture) without spending tokens. Returns
// the raw mock reply so the test can assert it carries the seeded text. mockMode
// short-circuits inside runOrchestrator BEFORE any usage gate / profile load, so
// this never touches the network.
export async function runScenarioMock(scenario: Scenario, flagConfig: FlagConfig): Promise<TurnRecord> {
  const userId = `evalmock-${scenario.id}-${flagConfig.name}`;
  const touchedKeys = Object.keys(flagConfig.flags);
  const snapshot = new Map<string, string | undefined>();
  for (const k of touchedKeys) snapshot.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(flagConfig.flags)) process.env[k] = v;
    const sessionStore = createInMemorySessionStore();
    const trailingText = await seedHistory(sessionStore, userId, scenario);
    const profileStore = buildMockProfileStore(userId, scenario.profile);
    const { rawReply, telemetry } = await driveOrchestrator({
      userId,
      text: trailingText,
      sessionStore,
      profileStore,
      mockMode: true,
    });
    return {
      scenarioId: scenario.id,
      flagConfigName: flagConfig.name,
      reply: rawReply,
      rawReply,
      suppressed: false,
      tools: telemetry?.tools ?? [],
      outcome: telemetry?.outcome,
      fastPath: telemetry?.outcome === 'fast_path',
    };
  } finally {
    for (const [k, v] of snapshot.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
