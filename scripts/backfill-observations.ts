// scripts/backfill-observations.ts
//
// One-time backfill: seed the `user_observations` log from existing `messages`
// history so GEORGE_RECALL_ENABLED has something to recall the day observation
// is first turned on (otherwise recall looks broken for days while the log
// accumulates from new turns only).
//
// It replays each user→assistant turn through the SAME Observer extraction the
// per-turn capturer uses (extractMemoryFromTurn), then writes the resulting
// observations (clamped salience, validated kind, best-effort embedding) into
// user_observations via the same ObservationDB seam.
//
// This is a MANUAL CLI. It is NOT wired into the server runtime — no env flag,
// nothing in src/index.ts ever imports it, it never auto-runs. Default is
// DRY-RUN: it logs what it WOULD write and writes nothing. Pass --execute to
// actually insert.
//
// IDEMPOTENCY: it does NOT dedupe against rows already in user_observations.
// Run it ONCE per user (or after a wipe) or you will get duplicate observations.
//
// Usage:
//   pnpm tsx scripts/backfill-observations.ts --user +17474638880          (dry-run, one user)
//   pnpm tsx scripts/backfill-observations.ts --user <uuid> --execute      (one user, write)
//   pnpm tsx scripts/backfill-observations.ts --all --limit 200            (dry-run, all onboarded)
//   pnpm tsx scripts/backfill-observations.ts --all --execute              (write, all onboarded)
//   optional: --per-turn-cap <N>  cap observations kept per turn

import 'dotenv/config';
import { createServiceRoleClient } from '../src/memory/supabase-client.js';
import { resolveProfileUserId } from '../src/db/students.js';
import {
  extractMemoryFromTurn,
  clampSalience,
  validateKind,
} from '../src/memory/capture.js';
import {
  embedObservation,
  createSupabaseObservationDB,
  type ObservationDB,
} from '../src/memory/observations.js';

const DEFAULT_LIMIT = 400;
// How many extracted-observation samples to echo per user in dry-run, so the
// operator can eyeball quality without flooding the terminal.
const DRY_RUN_SAMPLE_LIMIT = 8;

// One row from the `messages` table — the exact columns session-store.ts reads.
export interface MessageRow {
  role: string; // 'user' | 'assistant' | 'system'
  content: string;
  created_at: string;
}

// A paired conversational turn: a user message and the assistant reply that
// followed it.
export interface Turn {
  userText: string;
  assistantText: string;
}

// What the backfill produces per insertable observation, pre-write.
export interface PendingObservation {
  content: string;
  salience: number;
  kind?: string;
  embedding: number[] | null;
}

export interface BackfillOptions {
  limit?: number;
  execute?: boolean;
  perTurnCap?: number;
}

export interface BackfillResult {
  // Resolved + onboarded; false means we skipped this user entirely.
  resolved: boolean;
  userId: string | null;
  scanned: number; // turns paired and run through extraction
  extracted: number; // observations the LLM emitted (after content/clamp filtering)
  inserted: number; // rows written (execute) or that WOULD be written (dry-run)
  samples: PendingObservation[]; // small sample for dry-run printing
}

// Seam the CLI wires to real implementations; tests inject fakes so no network,
// no LLM, no Supabase.
export interface BackfillDeps {
  resolveUser: (handle: string) => Promise<string | null>;
  loadMessages: (userId: string, limit: number) => Promise<MessageRow[]>;
  extract: (userText: string, assistantText: string) => Promise<{
    observations: Array<{ content?: string; salience?: number; kind?: string }>;
  }>;
  embed: (text: string) => Promise<number[] | null>;
  observationDB: Pick<ObservationDB, 'insert'>;
}

// Pair consecutive user→assistant turns. We walk the chronological list and,
// for each 'user' message, take the NEXT 'assistant' message as its reply. A
// user message with no following assistant message (e.g. the last unanswered
// one) is dropped. Non-user/assistant roles (system) are ignored. This mirrors
// what the per-turn capturer sees: one (userText, assistantText) pair.
export function pairTurns(messages: MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  let pendingUser: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      // A new user message supersedes any prior unanswered user message.
      pendingUser = m.content;
    } else if (m.role === 'assistant' && pendingUser !== null) {
      turns.push({ userText: pendingUser, assistantText: m.content });
      pendingUser = null;
    }
    // system / other roles are skipped without resetting pendingUser.
  }
  return turns;
}

// Core, pure-ish backfill for one user. No argv parsing, no process.exit; the
// CLI main() wires real deps and prints. Returns counts so tests can assert.
export async function backfillForUser(
  deps: BackfillDeps,
  handle: string,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const execute = opts.execute ?? false;
  const perTurnCap = opts.perTurnCap;

  const userId = await deps.resolveUser(handle);
  if (!userId) {
    // Non-onboarded (handle with no student uuid behind it) → nothing to key
    // observations by. Skip.
    return { resolved: false, userId: null, scanned: 0, extracted: 0, inserted: 0, samples: [] };
  }

  const messages = await deps.loadMessages(userId, limit);
  const turns = pairTurns(messages);

  let scanned = 0;
  let extracted = 0;
  let inserted = 0;
  const samples: PendingObservation[] = [];

  for (const turn of turns) {
    scanned++;
    try {
      const { observations } = await deps.extract(turn.userText, turn.assistantText);
      let keptThisTurn = 0;
      for (const o of observations) {
        if (perTurnCap !== undefined && keptThisTurn >= perTurnCap) break;
        const content = o.content?.trim();
        if (!content) continue;
        const salience = clampSalience(o.salience);
        const kind = validateKind(o.kind);
        extracted++;
        keptThisTurn++;
        // Best-effort embedding; null is fine (insert tolerates it).
        const embedding = await deps.embed(content);
        const pending: PendingObservation = { content, salience, kind, embedding };
        if (samples.length < DRY_RUN_SAMPLE_LIMIT) samples.push(pending);
        if (execute) {
          await deps.observationDB.insert(userId, { content, salience, kind }, embedding);
        }
        inserted++;
      }
    } catch (err) {
      // One bad turn (LLM error, parse blowup, transient embed/insert failure)
      // must not abort the rest of this user's history.
      console.error(`  [turn] skipped a turn for ${userId}: ${(err as Error).message}`);
    }
  }

  return { resolved: true, userId, scanned, extracted, inserted, samples };
}

// ── CLI plumbing (not exercised by unit tests) ──────────────────────────────

interface ParsedArgs {
  user?: string;
  all: boolean;
  limit: number;
  execute: boolean;
  perTurnCap?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { all: false, limit: DEFAULT_LIMIT, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--user':
        args.user = argv[++i];
        break;
      case '--all':
        args.all = true;
        break;
      case '--limit':
        args.limit = parseInt(argv[++i], 10) || DEFAULT_LIMIT;
        break;
      case '--execute':
        args.execute = true;
        break;
      case '--per-turn-cap':
        args.perTurnCap = parseInt(argv[++i], 10);
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.user && !args.all) {
    console.error('Usage: backfill-observations --user <handle|uuid> | --all [--limit N] [--per-turn-cap N] [--execute]');
    console.error('Without --execute this is a DRY-RUN (writes nothing).');
    process.exit(1);
  }

  const mode = args.execute ? 'EXECUTE (writing rows)' : 'DRY-RUN (no writes)';
  console.log(`[backfill-observations] mode: ${mode}`);
  console.log(`[backfill-observations] limit per user: ${args.limit}${args.perTurnCap !== undefined ? `, per-turn cap: ${args.perTurnCap}` : ''}`);
  console.log('');
  console.log('  ⚠️  WARNING: this script does NOT dedupe against existing user_observations rows.');
  console.log('  ⚠️  Run it ONCE per user (or only after a wipe). Re-running creates DUPLICATES.');
  console.log('');

  const supabase = createServiceRoleClient();
  const observationDB = createSupabaseObservationDB();

  // Real deps. loadMessages reads the same `messages` table session-store reads,
  // newest-first capped at `limit`, then reversed to chronological so pairTurns
  // walks user→assistant in order.
  const deps: BackfillDeps = {
    resolveUser: (handle) => resolveProfileUserId(handle),
    async loadMessages(userId, limit) {
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`loadMessages failed: ${error.message}`);
      return ((data ?? []) as MessageRow[]).reverse();
    },
    extract: (userText, assistantText) => extractMemoryFromTurn(userText, assistantText),
    embed: (text) => embedObservation(text),
    observationDB,
  };

  // Resolve the target list. --all enumerates onboarded users straight from
  // user_profiles (the uuid-keyed table that only onboarded students have a row
  // in); each uuid passes through resolveProfileUserId unchanged.
  let targets: string[];
  if (args.all) {
    const { data, error } = await supabase.from('user_profiles').select('user_id');
    if (error) {
      console.error(`[backfill-observations] failed to list onboarded users: ${error.message}`);
      process.exit(1);
    }
    targets = (data ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean);
    console.log(`[backfill-observations] --all: ${targets.length} onboarded users`);
  } else {
    targets = [args.user!];
  }

  let totalScanned = 0;
  let totalExtracted = 0;
  let totalInserted = 0;
  let totalSkipped = 0;

  for (const target of targets) {
    try {
      const r = await backfillForUser(deps, target, {
        limit: args.limit,
        execute: args.execute,
        perTurnCap: args.perTurnCap,
      });
      if (!r.resolved) {
        totalSkipped++;
        console.log(`[skip] ${target}: not onboarded (no profile uuid), skipped`);
        continue;
      }
      totalScanned += r.scanned;
      totalExtracted += r.extracted;
      totalInserted += r.inserted;
      const verb = args.execute ? 'inserted' : 'would insert';
      console.log(`[user] ${target} → ${r.userId}: ${r.scanned} turns scanned, ${r.extracted} observations extracted, ${verb} ${r.inserted}`);
      if (!args.execute && r.samples.length > 0) {
        console.log(`  sample observations (up to ${DRY_RUN_SAMPLE_LIMIT}):`);
        for (const s of r.samples) {
          console.log(`    - [s${s.salience}${s.kind ? `/${s.kind}` : ''}] ${s.content}${s.embedding ? '' : ' (no embedding)'}`);
        }
      }
    } catch (err) {
      // One user failing wholesale (e.g. loadMessages threw) must not abort the
      // whole run.
      totalSkipped++;
      console.error(`[user] ${target}: FAILED — ${(err as Error).message}`);
    }
  }

  console.log('');
  const verb = args.execute ? 'inserted' : 'would insert';
  console.log(`[backfill-observations] TOTAL: ${totalScanned} turns scanned, ${totalExtracted} observations extracted, ${verb} ${totalInserted}, ${totalSkipped} users skipped`);
  if (!args.execute) {
    console.log('[backfill-observations] DRY-RUN complete — nothing was written. Re-run with --execute to apply.');
  } else {
    console.log('[backfill-observations] EXECUTE complete.');
  }
}

// Only run main() when invoked directly as a CLI, never on import (so the test
// file can import backfillForUser/pairTurns without triggering a DB run).
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('backfill-observations.ts');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[backfill-observations] fatal:', err);
    process.exit(1);
  });
}
