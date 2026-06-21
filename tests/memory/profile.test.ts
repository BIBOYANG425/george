// tests/memory/profile.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryCache } from '../../src/memory/kv-cache';
import { ProfileStore, BLOCK_NAMES } from '../../src/memory/profile';

const FAKE_USER = 'test-user-123';

function makeStore() {
  const cache = createInMemoryCache();
  const rows = new Map<string, Record<string, string>>();
  const db = {
    async loadRow(userId: string) {
      return rows.get(userId) ?? null;
    },
    async upsertBlock(userId: string, block: string, content: string) {
      const existing = rows.get(userId) ?? Object.fromEntries(BLOCK_NAMES.map((b) => [b, '']));
      existing[block] = content;
      rows.set(userId, existing);
    },
  };
  return { store: new ProfileStore(db, cache), cache, db };
}

describe('ProfileStore', () => {
  it('loadProfile returns empty blocks for new user', async () => {
    const { store } = makeStore();
    const p = await store.loadProfile(FAKE_USER);
    expect(p.identity).toBe('');
    expect(p.academic).toBe('');
    expect(p.interests).toBe('');
    expect(p.relationships).toBe('');
    expect(p.state).toBe('');
    expect(p.george_notes).toBe('');
  });

  it('saveBlock then loadProfile returns updated content', async () => {
    const { store } = makeStore();
    await store.saveBlock(FAKE_USER, 'identity', 'name: Alice');
    const p = await store.loadProfile(FAKE_USER);
    expect(p.identity).toBe('name: Alice');
  });

  it('saveBlock invalidates KV cache', async () => {
    const { store, cache } = makeStore();
    await cache.set(`user:${FAKE_USER}:profile`, JSON.stringify({ identity: 'stale' }), 300);
    await store.saveBlock(FAKE_USER, 'identity', 'name: Alice');
    expect(await cache.get(`user:${FAKE_USER}:profile`)).toBeNull();
  });

  it('saveBlock rejects unknown block name', async () => {
    const { store } = makeStore();
    await expect(store.saveBlock(FAKE_USER, 'notreal' as any, 'x')).rejects.toThrow(/block name/);
  });

  it('saveBlock rejects content >4000 chars', async () => {
    const { store } = makeStore();
    await expect(store.saveBlock(FAKE_USER, 'identity', 'x'.repeat(4001))).rejects.toThrow(/too long/);
  });
});
