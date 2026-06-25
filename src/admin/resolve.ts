// src/admin/resolve.ts
//
// Shared handle→key resolution for the admin dashboard. A dashboard always starts
// from a channel handle (or a uuid), but the two memory-bearing tables are keyed
// differently, and the resolution logic was previously duplicated inline in
// analytics.ts (getUserDetail + setHeartbeatPaused). This is the single home so
// the read AND write paths resolve identity the same way (PR-N's delete/clear
// reuse resolveProfileKey before mutating).
//
//   - PROFILE key  → the students.user_id uuid that user_profiles AND
//     user_observations are keyed by. Delegates to resolveProfileUserId — the very
//     same bridge the per-turn memory hot path uses — so the dashboard sees exactly
//     the profile/observations George reads and writes.
//   - HEARTBEAT config → user_heartbeat_config may store its row under the raw
//     handle, the student uuid, OR students.id depending on how the user was
//     created. We probe that candidate ring and return the row that actually exists.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveProfileUserId } from '../db/students.js';

// handle (or uuid) → the user_profiles / user_observations uuid, or null when no
// onboarded student sits behind the handle. UUID inputs pass straight through.
// `resolveProfileUserId` is cached (5-min WeakMap), so calling this twice in one
// request (profile + observations) costs one students round-trip, not two.
export async function resolveProfileKey(sb: SupabaseClient, handle: string): Promise<string | null> {
  return resolveProfileUserId(handle, sb);
}

// Probe the heartbeat-config candidate ring and return the matching row + the key
// it was found under (null when none of the candidates has a config row). The full
// row is returned (select('*')) so read callers (getUserDetail) get the config in
// one query, while write callers (setHeartbeatPaused) just use `.key`. Pass the
// candidate ring the caller already built from a loaded student — typically
// [handle, student.user_id, student.id] — to avoid a second students round-trip.
export async function resolveHeartbeatConfig(
  sb: SupabaseClient,
  candidates: Array<string | null | undefined>,
): Promise<{ key: string; row: Record<string, unknown> } | null> {
  for (const key of candidates.filter(Boolean) as string[]) {
    const { data } = await sb
      .from('user_heartbeat_config')
      .select('*')
      .eq('user_id', key)
      .maybeSingle();
    if (data) return { key, row: data as Record<string, unknown> };
  }
  return null;
}

// Does this PostgREST error message mean "the table isn't migrated in this
// environment" (vs a transient/real DB error)? The admin reads that touch
// optional/newer tables (e.g. user_observations) use this to degrade gracefully —
// a missing table renders a "未迁移" panel instead of 500-ing the page. Matches the
// two phrasings for an unknown relation: Postgres `relation "x" does not exist`
// (covered by "does not exist") and PostgREST `Could not find the table 'x' in the
// schema cache`. Deliberately does NOT match a bare "relation" — Postgres also says
// "permission denied for relation X", and misreading an RLS/permission failure as
// "unmigrated" would hide a real misconfiguration. Empty/undefined → false (an
// unknown error is a real error, not a missing table).
export function isMissingTableError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /does not exist|schema cache|could not find/i.test(message);
}
