// src/memory/recall.ts
//
// Per-turn Recall. Produces the render-ready memory block that Phase 2.2 injects
// into the prompt (e.g. "## THINGS YOU REMEMBER\n- ..."). Given the current user
// message, it embeds the message, asks the ObservationDB seam for the most
// relevant past observations, and renders them best-first under a header.
//
// Three invariants make this safe to call on the hot reply path:
//   1. Cheap & gated. OFF (GEORGE_RECALL_ENABLED unset) → return '' immediately,
//      before any resolve / embed / DB work, so the prompt is byte-identical to
//      pre-recall behavior and zero extra cost.
//   2. Never throws. Any failure (resolve, embed, RPC) → log warn + return '',
//      so recall can never block or break a reply.
//   3. Lazy client. The default Supabase-backed ObservationDB is constructed only
//      when recall is enabled and no fake is injected, so the OFF path and tests
//      never spin up a Supabase client.
//
// This module only READS. It does not write observations (that's capture.ts /
// the Observer) and it does not inject into the prompt (that's Phase 2.2).

import { resolveProfileUserId } from '../db/students.js';
import { log } from '../observability/logger.js';
import {
  embedObservation,
  createSupabaseObservationDB,
  type ObservationDB,
} from './observations.js';

const RECALL_HEADER = '## THINGS YOU REMEMBER';

// topK / minSalience defaults + bounds. topK floored at 1 (asking for 0 rows is
// pointless); minSalience clamped to the DB's 1..5 CHECK range.
const TOP_K_DEFAULT = 4;
const MIN_SALIENCE_DEFAULT = 2;
const MIN_SALIENCE_FLOOR = 1;
const MIN_SALIENCE_CEIL = 5;

// Recency-decay half-life passed to the recall_observations RPC (p_half_life_days,
// SQL default 14). Floored at 1 — a sub-day half-life would decay everything to ~0.
const HALF_LIFE_DAYS_DEFAULT = 14;
const HALF_LIFE_DAYS_FLOOR = 1;

// Hard cap on the rendered block, in characters. We append whole lines until the
// next line would exceed this; the header + 1 line is always kept if any row
// exists (a single oversized row is allowed through rather than dropping recall
// entirely). ~600 keeps the prompt cost bounded without truncating mid-line.
const BLOCK_CHAR_CAP = 600;

export function isRecallEnabled(): boolean {
  return process.env.GEORGE_RECALL_ENABLED === 'true';
}

// Parse an int env var, falling back to `fallback` on missing / NaN.
function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveTopK(): number {
  return Math.max(1, parseIntEnv(process.env.RECALL_TOP_K, TOP_K_DEFAULT));
}

function resolveMinSalience(): number {
  const n = parseIntEnv(process.env.RECALL_MIN_SALIENCE, MIN_SALIENCE_DEFAULT);
  return Math.min(MIN_SALIENCE_CEIL, Math.max(MIN_SALIENCE_FLOOR, n));
}

function resolveHalfLifeDays(): number {
  return Math.max(
    HALF_LIFE_DAYS_FLOOR,
    parseIntEnv(process.env.RECALL_HALF_LIFE_DAYS, HALF_LIFE_DAYS_DEFAULT),
  );
}

// Render the header + one "- <content>" line per row, in the order given
// (best-first). Append lines until the next would push past BLOCK_CHAR_CAP; never
// cut mid-line. Always keep header + 1 line if at least one row exists.
function renderBlock(contents: string[]): string {
  if (contents.length === 0) return '';
  let block = RECALL_HEADER;
  let first = true;
  for (const content of contents) {
    const line = `- ${content}`;
    const candidate = `${block}\n${line}`;
    // Always include the first line (header + 1 line guarantee); after that,
    // stop once adding the next line would exceed the cap.
    if (!first && candidate.length > BLOCK_CHAR_CAP) break;
    block = candidate;
    first = false;
  }
  return block.trimEnd();
}

// Returns a render-ready block or '' (empty). NEVER throws.
export async function recallForTurn(
  userId: string,
  message: string,
  deps?: { db?: ObservationDB; embed?: (t: string) => Promise<number[] | null> },
): Promise<string> {
  // 1. OFF → zero cost, no resolve/embed/DB work, byte-identical prompt.
  if (!isRecallEnabled()) return '';

  try {
    // 2. Non-onboarded handles have no uuid-keyed memory.
    const profileKey = await resolveProfileUserId(userId);
    if (!profileKey) return '';

    // 3. Nothing to embed against an empty turn.
    if (!message.trim()) return '';

    // 4. Best-effort embed; null = couldn't embed → skip recall this turn.
    const embed = deps?.embed ?? embedObservation;
    const embedding = await embed(message);
    if (!embedding) return '';

    // 5. Lazy default DB: only construct the real Supabase client when enabled
    //    and no fake was injected.
    const db = deps?.db ?? createSupabaseObservationDB();
    const rows = await db.recall(
      profileKey,
      embedding,
      resolveTopK(),
      resolveMinSalience(),
      resolveHalfLifeDays(),
    );

    // 6. No matches → empty block.
    if (rows.length === 0) return '';

    // 7. Render best-first, capped.
    return renderBlock(rows.map((r) => r.content));
  } catch (e) {
    // 8. Never block a reply on a recall failure.
    log('warn', 'recall_failed', { error: (e as Error).message });
    return '';
  }
}
