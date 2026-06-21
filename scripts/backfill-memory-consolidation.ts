// scripts/backfill-memory-consolidation.ts
//
// Phase 1.5 — one-time, idempotent backfill of existing users' memory out of the
// legacy homes into the clean ones Phase 1 created:
//
//   - The relationship note: from the sentinel-fenced block inside the
//     `user_profiles.george_notes` markdown blob → the dedicated
//     `user_profiles.relationship_note` column.
//   - The raised-thread ledger: from `RAISED_THREAD:` lines inside the same blob
//     → the `proactive_raised_threads` table.
//   - The dead `student_memories` key/value facts → the matching 6-block profile
//     columns (unknown categories land in `george_notes`).
//
// Phase 1 made George dual-read (real homes + blob fallback). This backfill moves
// the data so the fallback can be removed in a later phase. Every write goes
// through an idempotent path (saveRelationshipNote upsert, recordRaisedThread
// unique-index upsert, append_to_profile_block dedupe-by-substring), so re-running
// the script is safe.
//
// Run (the HUMAN runs these, NOT the agent that wrote this file):
//   tsx scripts/backfill-memory-consolidation.ts --dry-run   # tally, no writes
//   tsx scripts/backfill-memory-consolidation.ts             # live backfill
//
// The two pure helpers (splitGeorgeNotes, planBackfill) are exported and unit
// tested in tests/memory/backfill.test.ts. Importing this module does NOT run the
// backfill or touch a DB — run() only fires under the bottom main-guard, which is
// false when the module is imported (e.g. by the test or by another module).

import {
  extractRelationshipNote,
  upsertRelationshipNote,
  ProfileStore,
  createSupabaseProfileDB,
  type BlockName,
} from '../src/memory/profile.js';
import {
  parseRaisedThreads,
  stripRaisedThreadLines,
  recordRaisedThread,
  createSupabaseRaisedThreadDB,
} from '../src/agent/grounded-proactive.js';
import { createInMemoryCache } from '../src/memory/kv-cache.js';
import { createServiceRoleClient } from '../src/memory/supabase-client.js';

// ── Pure helper 1: split a legacy george_notes blob into its three homes ──────
// note      → the sentinel-fenced relationship note (empty string if none)
// threads   → the RAISED_THREAD: ledger keys (empty array if none)
// scratchpad→ the free-form remainder, with both the fenced note and the ledger
//             lines stripped, trimmed. This is what stays in george_notes.
export function splitGeorgeNotes(blob: string): { note: string; threads: string[]; scratchpad: string } {
  const note = extractRelationshipNote(blob);
  const threads = [...parseRaisedThreads(blob)];
  // Strip the fenced note first (upsertRelationshipNote(blob, '') removes the
  // fence), then strip the ledger lines, then trim.
  const scratchpad = stripRaisedThreadLines(upsertRelationshipNote(blob, '')).trim();
  return { note, threads, scratchpad };
}

// ── Pure helper 2: plan student_memories → profile-block appends ─────────────
// Maps each legacy student_memories category to a profile block (case-insensitive),
// resolves student_id → user_id, and records any unresolvable student_ids in
// `unresolved` so they are SKIPPED, never silently dropped.
const CATEGORY_TO_BLOCK: Record<string, BlockName> = {
  academic: 'academic',
  interest: 'interests',
  interests: 'interests',
  relationship: 'relationships',
  relationships: 'relationships',
  state: 'state',
  identity: 'identity',
};

function categoryToBlock(category: string): BlockName {
  return CATEGORY_TO_BLOCK[category.trim().toLowerCase()] ?? 'george_notes';
}

export function planBackfill(
  rows: Array<{ student_id: string; category: string; value: string }>,
  studentIdToUserId: Map<string, string>,
): { appends: Array<{ userId: string; block: BlockName; addition: string }>; unresolved: string[] } {
  const appends: Array<{ userId: string; block: BlockName; addition: string }> = [];
  const unresolved: string[] = [];
  for (const row of rows) {
    const userId = studentIdToUserId.get(row.student_id);
    if (!userId) {
      unresolved.push(row.student_id);
      continue;
    }
    appends.push({ userId, block: categoryToBlock(row.category), addition: row.value });
  }
  return { appends, unresolved };
}

// ── Main (DB I/O) ────────────────────────────────────────────────────────────
async function run({ dryRun }: { dryRun: boolean }): Promise<void> {
  const supabase = createServiceRoleClient();
  const store = new ProfileStore(createSupabaseProfileDB(), createInMemoryCache());
  const raisedDb = createSupabaseRaisedThreadDB();

  const tally = {
    usersProcessed: 0,
    notesMoved: 0,
    threadsMoved: 0,
    memoryRowsAppended: 0,
    unresolvedSkipped: 0,
  };

  // 1. user_profiles: split each blob, move note + threads + cleaned scratchpad.
  console.log('[backfill] loading user_profiles...');
  const { data: profiles, error: pErr } = await supabase
    .from('user_profiles')
    .select('user_id, george_notes');
  if (pErr) throw new Error(`load user_profiles failed: ${pErr.message}`);

  for (const profile of profiles ?? []) {
    const userId = profile.user_id as string;
    const original = (profile.george_notes ?? '') as string;
    const { note, threads, scratchpad } = splitGeorgeNotes(original);
    tally.usersProcessed += 1;

    if (note) {
      if (!dryRun) await store.saveRelationshipNote(userId, note);
      tally.notesMoved += 1;
    }
    for (const thread of threads) {
      if (!dryRun) await recordRaisedThread(raisedDb, userId, thread);
      tally.threadsMoved += 1;
    }
    // Only rewrite george_notes when stripping actually changed it (so users with
    // a clean blob get no spurious write).
    if (scratchpad !== original.trim()) {
      if (!dryRun) await store.saveBlock(userId, 'george_notes', scratchpad);
    }
  }

  // 2. student_memories → profile blocks, resolving student_id → user_id.
  console.log('[backfill] loading student_memories + students...');
  const { data: memories, error: mErr } = await supabase
    .from('student_memories')
    .select('student_id, category, value');
  if (mErr) throw new Error(`load student_memories failed: ${mErr.message}`);

  const { data: students, error: sErr } = await supabase.from('students').select('id, user_id');
  if (sErr) throw new Error(`load students failed: ${sErr.message}`);

  const studentIdToUserId = new Map<string, string>();
  for (const s of students ?? []) {
    if (s.id != null && s.user_id != null) studentIdToUserId.set(String(s.id), String(s.user_id));
  }

  const plan = planBackfill(
    (memories ?? []).map((m) => ({
      student_id: String(m.student_id),
      category: String(m.category ?? ''),
      value: String(m.value ?? ''),
    })),
    studentIdToUserId,
  );

  for (const append of plan.appends) {
    if (!dryRun) await store.appendToBlock(append.userId, append.block, append.addition);
    tally.memoryRowsAppended += 1;
  }
  tally.unresolvedSkipped = plan.unresolved.length;
  if (plan.unresolved.length > 0) {
    console.log(
      `[backfill] ${plan.unresolved.length} student_memories rows had unresolvable student_id (skipped, NOT dropped):`,
      plan.unresolved,
    );
  }

  // 3. Summary.
  console.log('[backfill] ────────── summary ──────────');
  console.log(`[backfill] users processed:        ${tally.usersProcessed}`);
  console.log(`[backfill] relationship notes moved:${tally.notesMoved}`);
  console.log(`[backfill] raised threads moved:    ${tally.threadsMoved}`);
  console.log(`[backfill] memory rows appended:    ${tally.memoryRowsAppended}`);
  console.log(`[backfill] unresolved skipped:      ${tally.unresolvedSkipped}`);
  if (dryRun) {
    console.log('[backfill] DRY RUN — no writes');
  } else {
    console.log('[backfill] complete.');
  }
}

// Main-guard: run() ONLY when this file is invoked directly (tsx
// scripts/backfill-memory-consolidation.ts). When the module is imported (the
// test, or any other module), process.argv[1] is the importer/runner, not this
// script, so run() never fires and no DB connection is opened on import.
if (process.argv[1]?.endsWith('backfill-memory-consolidation.ts')) {
  run({ dryRun: process.argv.includes('--dry-run') }).catch((err) => {
    console.error('[backfill] failed:', err);
    process.exit(1);
  });
}
