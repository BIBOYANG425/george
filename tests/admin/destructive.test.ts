// tests/admin/destructive.test.ts
// PR-N destructive memory ops. The guards that matter:
//   - the handle is resolved to the SAME uuid the memory path keys by (never clear
//     the wrong user);
//   - clearing goes through ProfileStore.saveBlock('') so the KV cache is BUSTED
//     (a raw DB write would leave a 5-min-stale block) — asserted via the fake cache;
//   - the original value is snapshotted into the audit payload (recoverable);
//   - observation delete is owner-scoped (deleteById gets the resolved uuid).
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clearProfileBlock, deleteObservation } from '../../src/admin/actions';
import { ProfileStore } from '../../src/memory/profile';
import { __resetResolveProfileCache } from '../../src/db/students';

const UUID = 'e1af86be-1234-4abc-9def-0123456789ab';

// sb serving resolveProfileUserId's students lookup + capturing admin_audit_log inserts.
function adminSb(students: Array<Record<string, unknown>>, audit: Array<Record<string, unknown>>): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'students') {
        const filters: Array<(r: any) => boolean> = [];
        const api: any = {
          select: () => api,
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), api),
          not: (c: string) => (filters.push((r) => r[c] != null), api),
          limit: () => api,
          maybeSingle: async () => ({ data: students.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        };
        return api;
      }
      return { async insert(row: Record<string, unknown>) { audit.push(row); return { error: null }; } };
    },
  } as unknown as SupabaseClient;
}

function fakeStore(blockValues: Record<string, unknown>) {
  const upserts: Array<{ userId: string; block: string; content: string }> = [];
  const cacheDeletes: string[] = [];
  const db: any = {
    async loadRow() { return blockValues; },
    async upsertBlock(userId: string, block: string, content: string) { upserts.push({ userId, block, content }); },
  };
  const cache: any = { async get() { return null; }, async set() {}, async delete(k: string) { cacheDeletes.push(k); } };
  return { store: new ProfileStore(db, cache), upserts, cacheDeletes };
}

describe('clearProfileBlock', () => {
  beforeEach(() => __resetResolveProfileCache());

  it('clears via ProfileStore (busts KV) + audits the ORIGINAL value', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const sb = adminSb([], audit);
    const { store, upserts, cacheDeletes } = fakeStore({ identity: 'studies CS, sophomore', academic: '' });

    const r = await clearProfileBlock(sb, store, UUID, 'identity', 'admin@uscbia.com');
    expect(r.ok).toBe(true);
    // overwrote with empty
    expect(upserts).toEqual([{ userId: UUID, block: 'identity', content: '' }]);
    // KV cache was busted for this user (Codex#5)
    expect(cacheDeletes).toContain(`user:${UUID}:profile`);
    // audit captured the original for recovery
    expect(audit[0]).toMatchObject({
      admin_email: 'admin@uscbia.com',
      action: 'clear_profile_block',
      entity_type: 'profile',
      entity_id: UUID,
      payload: { block: 'identity', original: 'studies CS, sophomore' },
    });
  });

  it('resolves a channel HANDLE to the uuid before clearing (never the wrong user)', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const sb = adminSb([{ imessage_id: '+17474638880', user_id: UUID }], audit);
    const { store, upserts } = fakeStore({ academic: 'CSCI 270 this term' });
    const r = await clearProfileBlock(sb, store, '+17474638880', 'academic', 'admin@x');
    expect(r.ok).toBe(true);
    expect(upserts[0].userId).toBe(UUID); // resolved, not the raw handle
    expect(audit[0].entity_id).toBe(UUID);
  });

  it('rejects an invalid block name (no write, no audit)', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const { store, upserts } = fakeStore({});
    const r = await clearProfileBlock(adminSb([], audit), store, UUID, 'bogus', 'a');
    expect(r.ok).toBe(false);
    expect(upserts).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('fails when the handle resolves to no profile', async () => {
    const { store } = fakeStore({});
    const r = await clearProfileBlock(adminSb([], []), store, '+19999999999', 'identity', 'a');
    expect(r.ok).toBe(false);
  });
});

describe('deleteObservation', () => {
  beforeEach(() => __resetResolveProfileCache());

  function fakeObsDb(removed: number) {
    const calls: Array<{ userId: string; id: number }> = [];
    const db: any = { async deleteById(userId: string, id: number) { calls.push({ userId, id }); return removed; } };
    return { db, calls };
  }

  it('deletes owner-scoped (resolved uuid) + audits removed count', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const { db, calls } = fakeObsDb(1);
    const r = await deleteObservation(adminSb([], audit), db, UUID, 42, 'admin@x');
    expect(r).toMatchObject({ ok: true, removed: 1 });
    expect(calls).toEqual([{ userId: UUID, id: 42 }]); // scoped to the resolved uuid
    expect(audit[0]).toMatchObject({ action: 'delete_observation', entity_id: UUID, payload: { observationId: 42, removed: 1 } });
  });

  it('missing / not-owned id is a no-op (removed: 0) but still audited', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const { db } = fakeObsDb(0);
    const r = await deleteObservation(adminSb([], audit), db, UUID, 999, 'a');
    expect(r).toMatchObject({ ok: true, removed: 0 });
    expect(audit[0]).toMatchObject({ payload: { observationId: 999, removed: 0 } });
  });

  it('rejects a non-numeric id', async () => {
    const { db, calls } = fakeObsDb(1);
    const r = await deleteObservation(adminSb([], []), db, UUID, NaN, 'a');
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
