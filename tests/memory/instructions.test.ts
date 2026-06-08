// tests/memory/instructions.test.ts
import { describe, it, expect } from 'vitest';
import { createInMemoryCache } from '../../src/memory/kv-cache';
import { InstructionsStore } from '../../src/memory/instructions';

const FAKE_USER = 'u1';

function makeStore() {
  const cache = createInMemoryCache();
  const rows = new Map<string, string>();
  const db = {
    async load(userId: string) {
      return rows.get(userId) ?? null;
    },
    async save(userId: string, content: string) {
      rows.set(userId, content);
    },
  };
  return { store: new InstructionsStore(db, cache), cache, db };
}

describe('InstructionsStore', () => {
  it('load returns empty for new user', async () => {
    const { store } = makeStore();
    expect(await store.load(FAKE_USER)).toBe('');
  });

  it('save then load returns content', async () => {
    const { store } = makeStore();
    await store.save(FAKE_USER, '# Standing instructions\n\nCadence: weekly_wed');
    expect(await store.load(FAKE_USER)).toBe('# Standing instructions\n\nCadence: weekly_wed');
  });

  it('save invalidates cache', async () => {
    const { store, cache } = makeStore();
    await cache.set(`user:${FAKE_USER}:instructions`, 'stale', 300);
    await store.save(FAKE_USER, 'fresh');
    expect(await cache.get(`user:${FAKE_USER}:instructions`)).toBeNull();
  });

  it('save rejects content >10000 chars', async () => {
    const { store } = makeStore();
    await expect(store.save(FAKE_USER, 'x'.repeat(10001))).rejects.toThrow(/too long/);
  });
});
