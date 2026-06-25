// tests/admin/resolve.test.ts
// PR-1 shared resolution: resolveProfileKey bridges a channel handle to the
// user_profiles/user_observations uuid (delegating to the same resolver the memory
// hot path uses), and resolveHeartbeatConfig probes the candidate ring and returns
// the row under the key that actually exists — the dedup of the logic that was
// inline in analytics.ts getUserDetail + setHeartbeatPaused (§6A).
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveProfileKey, resolveHeartbeatConfig, isMissingTableError } from '../../src/admin/resolve';
import { __resetResolveProfileCache } from '../../src/db/students';

// .from(students).select().eq(col,val).not(col,'is',null).limit().maybeSingle()
function studentsSb(rows: Array<{ imessage_id?: string; wechat_open_id?: string; user_id?: string | null }>): SupabaseClient {
  return {
    from() {
      const filters: Array<(r: any) => boolean> = [];
      const api: any = {
        select: () => api,
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), api),
        not: (col: string) => (filters.push((r) => r[col] != null), api),
        limit: () => api,
        maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      };
      return api;
    },
  } as unknown as SupabaseClient;
}

// .from(user_heartbeat_config).select('*').eq('user_id', key).maybeSingle()
// Records every probed key so we can assert the ring stops at the first hit.
function heartbeatSb(byKey: Record<string, Record<string, unknown>>, probed: string[]) {
  return {
    from() {
      let probedKey = '';
      const api: any = {
        select: () => api,
        eq: (_col: string, val: string) => { probedKey = val; return api; },
        maybeSingle: async () => { probed.push(probedKey); return { data: byKey[probedKey] ?? null, error: null }; },
      };
      return api;
    },
  } as unknown as SupabaseClient;
}

describe('resolveProfileKey (handle → user_profiles/user_observations uuid)', () => {
  beforeEach(() => __resetResolveProfileCache());

  it('resolves a phone handle to the student user_id', async () => {
    const sb = studentsSb([{ imessage_id: '+17474638880', user_id: 'profile-uuid' }]);
    expect(await resolveProfileKey(sb, '+17474638880')).toBe('profile-uuid');
  });

  it('passes a uuid straight through', async () => {
    const uuid = 'e1af86be-1234-4abc-9def-0123456789ab';
    expect(await resolveProfileKey(studentsSb([]), uuid)).toBe(uuid);
  });

  it('returns null for an unknown handle', async () => {
    expect(await resolveProfileKey(studentsSb([]), '+19999999999')).toBeNull();
  });
});

describe('resolveHeartbeatConfig (candidate-ring probe)', () => {
  it('returns the row + key for the first candidate that has a config row', async () => {
    const probed: string[] = [];
    const sb = heartbeatSb({ 'student-uuid': { user_id: 'student-uuid', paused: true } }, probed);
    const r = await resolveHeartbeatConfig(sb, ['+17474638880', 'student-uuid', 'students-id']);
    expect(r).toEqual({ key: 'student-uuid', row: { user_id: 'student-uuid', paused: true } });
    // stops at the first hit — never probes the third candidate
    expect(probed).toEqual(['+17474638880', 'student-uuid']);
  });

  it('matches on the raw handle when the row is keyed by it', async () => {
    const probed: string[] = [];
    const sb = heartbeatSb({ '+17474638880': { user_id: '+17474638880' } }, probed);
    const r = await resolveHeartbeatConfig(sb, ['+17474638880', 'student-uuid']);
    expect(r?.key).toBe('+17474638880');
    expect(probed).toEqual(['+17474638880']);
  });

  it('returns null when no candidate has a config row', async () => {
    const probed: string[] = [];
    const sb = heartbeatSb({}, probed);
    expect(await resolveHeartbeatConfig(sb, ['a', 'b'])).toBeNull();
    expect(probed).toEqual(['a', 'b']);
  });

  it('skips falsy candidates (undefined student.user_id / student.id)', async () => {
    const probed: string[] = [];
    const sb = heartbeatSb({ 'only-key': { user_id: 'only-key' } }, probed);
    const r = await resolveHeartbeatConfig(sb, ['only-key', undefined, null]);
    expect(r?.key).toBe('only-key');
    expect(probed).toEqual(['only-key']);
  });
});

describe('isMissingTableError (graceful-degradation classifier for optional admin reads)', () => {
  // TRUE: a not-yet-migrated table → degrade to a "未迁移" panel, never 500 the page.
  it.each([
    'relation "public.user_observations" does not exist',
    "Could not find the table 'public.user_observations' in the schema cache",
    'relation does not exist',
  ])('returns true for a missing-table message: %s', (msg) => {
    expect(isMissingTableError(msg)).toBe(true);
  });

  // FALSE: a real/transient DB error must NOT be mistaken for "table unmigrated"
  // (we don't want to tell the admin the table is missing when it's a timeout).
  // The `permission denied for relation` case is the Codex-flagged trap: a bare
  // "relation" match would misread an RLS/permission failure as "unmigrated".
  it.each([
    'connection timeout',
    'permission denied for relation "user_observations"',
    'JWT expired',
  ])('returns false for a non-missing-table error: %s', (msg) => {
    expect(isMissingTableError(msg)).toBe(false);
  });

  it('returns false for empty / null / undefined (unknown error is not "missing table")', () => {
    expect(isMissingTableError('')).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });
});
