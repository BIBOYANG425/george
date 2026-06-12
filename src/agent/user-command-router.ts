// src/agent/user-command-router.ts
// Side-effect-free router for the 5 iMessage user-control commands
// (/profile, /correct, /pause, /resume, /delete me). Extracted from
// src/index.ts so transports (e.g. the Spectrum adapter) can import
// tryHandleUserCommand WITHOUT pulling in index.ts's module-load side effects
// (which call startServer(), bind ports, and start cron schedulers).
//
// index.ts owns the runtime singletons (KV cache, ProfileStore, Supabase
// service-role client, the iMessage sender) and injects them here via
// setUserCommandRuntime() once the heartbeat layer initializes. Until that runs
// (e.g. HEARTBEAT_ENABLED=false), the runtime stays null and
// tryHandleUserCommand falls through to the orchestrator.
//
// Header last reviewed: 2026-06-11

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProfileStore } from '../memory/profile.js'
import type { KVCache } from '../memory/kv-cache.js'
import { parseAndRouteUserCommand, executeUserCommand, UserCommandDeps } from '../tools/user-commands.js'

// The raw runtime handles index.ts injects after the memory/heartbeat layer
// initializes. Kept minimal — the richer UserCommandDeps (with the DB closures)
// is assembled from these in buildUserCommandDeps().
export interface UserCommandRuntime {
  cache: KVCache
  profileStore: ProfileStore
  supabase: SupabaseClient
  sendImessage: (msg: { to: string; text: string }) => Promise<void>
}

let _runtime: UserCommandRuntime | null = null

// Called by index.ts once the memory/heartbeat layer is initialized. Passing
// null (or never calling it) leaves command routing disabled, so
// tryHandleUserCommand falls through to the orchestrator.
export function setUserCommandRuntime(runtime: UserCommandRuntime | null): void {
  _runtime = runtime
}

// Builds the full UserCommandDeps from the injected runtime. Returns null when
// the memory layer hasn't been initialised (HEARTBEAT_ENABLED=false).
function buildUserCommandDeps(): UserCommandDeps | null {
  if (!_runtime) return null;
  const { cache, profileStore, supabase, sendImessage } = _runtime;
  return {
    profileStore,
    async setPaused(userId: string, until: Date | null) {
      await supabase
        .from('user_heartbeat_config')
        .update({ paused: until !== null, pause_until: until?.toISOString() ?? null })
        .eq('user_id', userId);
      await cache.delete(`user:${userId}:profile`);
    },
    async deleteUserData(userId: string) {
      await Promise.all([
        supabase.from('user_profiles').delete().eq('user_id', userId),
        supabase.from('user_heartbeat_config').delete().eq('user_id', userId),
        supabase.from('user_heartbeat_instructions').delete().eq('user_id', userId),
        supabase.from('heartbeat_log').delete().eq('user_id', userId),
        supabase.from('student_followups').delete().eq('user_id', userId),
        supabase.from('messages').delete().eq('user_id', userId),
      ]);
      await cache.delete(`user:${userId}:profile`);
      await cache.delete(`user:${userId}:instructions`);
    },
    sendImessage,
    async setDeleteConfirmPending(userId: string, pending: boolean) {
      await cache.set(`user:${userId}:delete_pending`, pending ? '1' : '0', 300);
    },
    async getDeleteConfirmPending(userId: string) {
      return (await cache.get(`user:${userId}:delete_pending`)) === '1';
    },
    async writeAudit(entry: { userId: string; action: string; payload: Record<string, unknown> }) {
      try {
        await supabase.from('admin_audit_log').insert({
          actor_email: 'system@george',
          action: entry.action,
          entity_type: 'user',
          entity_id: entry.userId,
          payload: entry.payload,
        });
      } catch {
        // admin_audit_log may not exist yet; swallow so commands don't fail
      }
    },
  };
}

/**
 * Attempt to handle a user command message before the orchestrator sees it.
 * Returns the reply string if handled, or null if not a command (or memory
 * layer is uninitialised).
 */
export async function tryHandleUserCommand(
  userId: string,
  text: string,
): Promise<string | null> {
  const parsed = parseAndRouteUserCommand(text);
  if (parsed === null) return null;
  const deps = buildUserCommandDeps();
  if (deps === null) {
    // Memory layer off — fall through to orchestrator
    return null;
  }
  return executeUserCommand(userId, parsed, deps, text);
}
