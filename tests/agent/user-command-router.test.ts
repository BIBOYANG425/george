// tests/agent/user-command-router.test.ts
// Covers the /delete me PII-wipe path assembled in buildUserCommandDeps().
// The deleteUserData closure must wipe every per-user table — including the P6
// observation log (user_observations) — keyed by the same user_id used for
// user_profiles. Uses the repo's chainable-Supabase-stub idiom (see
// tests/memory/observations.test.ts).
import { describe, it, expect } from 'vitest';
import {
  setUserCommandRuntime,
  tryHandleUserCommand,
} from '../../src/agent/user-command-router.js';

const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// A thin chainable Supabase stub that records, per `.from(table)`, which terminal
// op ran and the eq() filter applied. Each builder is a thenable so `await` on a
// chain resolves to a benign { data, error } result.
function makeFakeSupabase() {
  // table -> { deleted, eq: [col, val][] }
  const ops: Record<string, { deleted: boolean; updated: boolean; eq: [string, any][] }> = {};

  function builderFor(table: string) {
    const entry = (ops[table] ??= { deleted: false, updated: false, eq: [] });
    const builder: any = {
      delete() { entry.deleted = true; return builder; },
      update() { entry.updated = true; return builder; },
      insert() { return builder; },
      select() { return builder; },
      eq(col: string, val: any) { entry.eq.push([col, val]); return builder; },
      then(resolve: any) { return Promise.resolve({ data: null, error: null }).then(resolve); },
    };
    return builder;
  }

  const supabase: any = {
    from(table: string) { return builderFor(table); },
  };

  return { supabase, ops };
}

function makeFakeCache() {
  const store = new Map<string, string>();
  const deleted: string[] = [];
  return {
    cache: {
      async get(key: string) { return store.get(key) ?? null; },
      async set(key: string, value: string) { store.set(key, value); },
      async delete(key: string) { deleted.push(key); store.delete(key); },
    },
    store,
    deleted,
  };
}

describe('/delete me — per-user PII wipe', () => {
  it('wipes user_observations (P6) along with every other per-user table, keyed by user_id', async () => {
    const { supabase, ops } = makeFakeSupabase();
    const { cache, store } = makeFakeCache();
    // Pre-arm the confirm flag so the second /delete me runs the wipe immediately.
    store.set(`user:${UID}:delete_pending`, '1');

    const sentMessages: { to: string; text: string }[] = [];
    setUserCommandRuntime({
      cache: cache as any,
      profileStore: {} as any,
      supabase,
      sendImessage: async (msg) => { sentMessages.push(msg); },
    });

    try {
      const reply = await tryHandleUserCommand(UID, '/delete me');
      expect(reply).toBe('done. take care.');

      // user_observations must be among the wiped tables, deleted by user_id —
      // the SAME key user_profiles is deleted by.
      expect(ops.user_observations).toBeDefined();
      expect(ops.user_observations.deleted).toBe(true);
      expect(ops.user_observations.eq).toContainEqual(['user_id', UID]);

      // Mirror the user_profiles assertion so the two move together.
      expect(ops.user_profiles.deleted).toBe(true);
      expect(ops.user_profiles.eq).toContainEqual(['user_id', UID]);

      // All the sibling per-user tables must still be wiped, by the same key.
      for (const table of [
        'user_profiles',
        'user_heartbeat_config',
        'user_heartbeat_instructions',
        'heartbeat_log',
        'student_followups',
        'messages',
        'user_observations',
      ]) {
        expect(ops[table]?.deleted, `${table} should be deleted`).toBe(true);
        expect(ops[table]?.eq, `${table} keyed by user_id`).toContainEqual(['user_id', UID]);
      }
    } finally {
      setUserCommandRuntime(null);
    }
  });

  it('does NOT wipe anything on the first /delete me (confirm gate)', async () => {
    const { supabase, ops } = makeFakeSupabase();
    const { cache } = makeFakeCache();

    setUserCommandRuntime({
      cache: cache as any,
      profileStore: {} as any,
      supabase,
      sendImessage: async () => {},
    });

    try {
      const reply = await tryHandleUserCommand(UID, '/delete me');
      expect(reply).toMatch(/reply \/delete me again/i);
      // Nothing deleted yet — confirm pending only.
      expect(Object.keys(ops)).toHaveLength(0);
    } finally {
      setUserCommandRuntime(null);
    }
  });
});
