// tests/eval/sim-users/arena.ts
//
// Runs one persona × one flag arm as a real multi-turn conversation: the
// simulator produces user turns, the REAL orchestrator produces george's
// replies, and the accumulated exchange is re-saved into the in-memory
// SessionStore each turn (its save() REPLACES the session) so george sees
// <conversation_history> exactly like production.
//
// Env discipline mirrors tests/eval/conversation/runner.ts: snapshot the arm's
// flags, set them for the WHOLE conversation, restore in finally.
// GEORGE_DISABLE_FAST_PATH is NOT pinned here by default — sim conversations
// include exactly the emotional turns the fast path exists for, and the arm's
// caller decides whether to pin it (path-flag A/Bs should NOT pin it away, the
// user experience under test includes it… but see sim-users.test.ts, which pins
// it ON both arms for the SINGLE_AGENT A/B so the architecture is what varies).
//
// gate-lite: per-reply deterministic checks reusing the SHIPPING voice-guard
// regex + the gate's structural constants. The full gate needs a Scenario with
// expectations; sim conversations have none, so we check only the universal
// rules (banned voice tells, marketing emoji, runaway length).
//
// Header last reviewed: 2026-07-01

import { createInMemorySessionStore } from '../../../src/agent/session-store.js';
import { ProfileStore, EMPTY_PROFILE } from '../../../src/memory/profile.js';
import { createInMemoryCache } from '../../../src/memory/kv-cache.js';
import { parseControlTokens } from '../../../src/adapters/split-response.js';
import { bannedVoiceHits } from '../../../src/agent/voice-guard.js';
import { driveOrchestrator } from '../conversation/runner.js';
import { nextUserTurn, type Persona, type SimTurn } from './simulator.js';
import type { FlagConfig } from '../conversation/types.js';

const TURN_DEADLINE_MS = 90_000;
const MAX_REPLY_LEN = 600; // sim gate-lite ceiling (scenarios use 400; multi-turn info replies get slack)
const MARKETING_EMOJI = ['🔥', '💯', '🎉'];

export interface SimTranscript {
  personaId: string;
  arm: string;
  turns: SimTurn[];
  stopped: 'goal_or_natural' | 'max_turns' | 'error';
  error?: string;
  meanGeorgeMs?: number;
  gateLiteFailureCount: number;
}

function gateLite(reply: string): string[] {
  const failures: string[] = [];
  for (const hit of bannedVoiceHits(reply)) failures.push(`banned_voice:${hit}`);
  for (const e of MARKETING_EMOJI) if (reply.includes(e)) failures.push(`marketing_emoji:${e}`);
  if (reply.length > MAX_REPLY_LEN) failures.push(`over_length:${reply.length}`);
  return failures;
}

function buildProfileStore(userId: string, partial?: Record<string, string>): ProfileStore | undefined {
  if (!partial) return undefined;
  const row: Record<string, string> = { ...EMPTY_PROFILE, ...partial };
  const rows = new Map<string, Record<string, string>>([[userId, row]]);
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
    createInMemoryCache(),
  );
}

export async function runSimConversation(
  persona: Persona,
  flagConfig: FlagConfig,
  opts: { mockMode?: boolean } = {},
): Promise<SimTranscript> {
  const userId = `sim-${persona.id}-${flagConfig.name}`;
  const touched = Object.keys(flagConfig.flags);
  const snapshot = new Map<string, string | undefined>();
  for (const k of touched) snapshot.set(k, process.env[k]);

  const turns: SimTurn[] = [];
  let stopped: SimTranscript['stopped'] = 'max_turns';
  let error: string | undefined;

  try {
    for (const [k, v] of Object.entries(flagConfig.flags)) process.env[k] = v;

    const sessionStore = createInMemorySessionStore();
    const profileStore = buildProfileStore(userId, persona.profile);

    for (let i = 0; i < persona.maxTurns; i++) {
      // Turn 1 uses the frozen opener (reproducible starts); later turns simulate.
      const userText = i === 0 ? persona.opener : await nextUserTurn(persona, turns);
      if (!userText) {
        stopped = 'goal_or_natural';
        break;
      }

      // Re-save the FULL accumulated history before each turn (save REPLACES).
      if (turns.length > 0) {
        await sessionStore.save(userId, {
          sessionId: userId,
          messages: turns.flatMap((t) => [
            { role: 'user' as const, content: t.user },
            { role: 'assistant' as const, content: t.george },
          ]),
          systemContext: {},
        });
      }

      const result = await Promise.race([
        driveOrchestrator({
          userId,
          text: userText,
          sessionStore,
          profileStore,
          mockMode: opts.mockMode ?? false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('sim_turn_deadline_exceeded')), TURN_DEADLINE_MS),
        ),
      ]);

      const reply = parseControlTokens(result.rawReply).text;
      turns.push({
        user: userText,
        george: reply,
        durationMs: result.telemetry?.durationMs,
        tools: result.telemetry?.tools ?? [],
        fastPath: result.telemetry?.outcome === 'fast_path',
        gateLiteFailures: gateLite(reply),
      });
    }
  } catch (err) {
    stopped = 'error';
    error = (err as Error).message;
  } finally {
    for (const [k, v] of snapshot.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const timed = turns.map((t) => t.durationMs).filter((d): d is number => typeof d === 'number');
  return {
    personaId: persona.id,
    arm: flagConfig.name,
    turns,
    stopped,
    error,
    meanGeorgeMs: timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : undefined,
    gateLiteFailureCount: turns.reduce((n, t) => n + t.gateLiteFailures.length, 0),
  };
}
