// tests/memory/profile.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryCache } from '../../src/memory/kv-cache';
import {
  ProfileStore,
  BLOCK_NAMES,
  extractRelationshipNote,
  upsertRelationshipNote,
  REL_NOTE_START,
  REL_NOTE_END,
} from '../../src/memory/profile';

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

describe('relationship note helpers (P3, zero-schema)', () => {
  it('extractRelationshipNote returns empty when no fence present', () => {
    expect(extractRelationshipNote('')).toBe('');
    expect(extractRelationshipNote('some unrelated heartbeat scratch')).toBe('');
  });

  it('upsert then extract round-trips the note', () => {
    const notes = upsertRelationshipNote('', 'they text terse and late-night, mostly about CS coursework');
    expect(notes).toContain(REL_NOTE_START);
    expect(notes).toContain(REL_NOTE_END);
    expect(extractRelationshipNote(notes)).toBe('they text terse and late-night, mostly about CS coursework');
  });

  it('upsert preserves pre-existing non-note content in the block', () => {
    const existing = 'raised: visa thread on 6/12\nproactive sent: event brief';
    const notes = upsertRelationshipNote(existing, 'warm rapport, leans on George for housing');
    expect(notes).toContain('raised: visa thread on 6/12');
    expect(notes).toContain('proactive sent: event brief');
    expect(extractRelationshipNote(notes)).toBe('warm rapport, leans on George for housing');
  });

  it('upsert is idempotent — rewriting replaces, never accumulates', () => {
    const first = upsertRelationshipNote('keep me', 'first note');
    const second = upsertRelationshipNote(first, 'second note');
    expect(extractRelationshipNote(second)).toBe('second note');
    // Only one fence pair survives.
    expect(second.split(REL_NOTE_START).length - 1).toBe(1);
    expect(second.split(REL_NOTE_END).length - 1).toBe(1);
    // Non-note content survives across rewrites.
    expect(second).toContain('keep me');
  });

  it('upsert with a blank note removes the fence but keeps other content', () => {
    const withNote = upsertRelationshipNote('keep me', 'temp note');
    const cleared = upsertRelationshipNote(withNote, '   ');
    expect(cleared).not.toContain(REL_NOTE_START);
    expect(extractRelationshipNote(cleared)).toBe('');
    expect(cleared).toContain('keep me');
  });
});
