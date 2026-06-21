import { describe, it, expect } from 'vitest';
import { ProfileStore } from '../../src/memory/profile.js';
import { createInMemoryCache } from '../../src/memory/kv-cache.js';

function makeStore() {
  const rows = new Map<string, Record<string, string>>();
  const db = {
    async loadRow(uid: string) { return rows.get(uid) ?? null; },
    async upsertBlock(uid: string, block: string, content: string) {
      rows.set(uid, { ...(rows.get(uid) ?? { user_id: uid }), [block]: content });
    },
    async saveRelationshipNote(uid: string, note: string) {
      rows.set(uid, { ...(rows.get(uid) ?? { user_id: uid }), relationship_note: note });
    },
  };
  return new ProfileStore(db as any, createInMemoryCache());
}

describe('relationship_note column', () => {
  it('writes + reads relationship_note via its own column', async () => {
    const s = makeStore();
    await s.saveRelationshipNote('u1', 'they ghost on weekends, finals stress');
    const p = await s.loadProfile('u1');
    expect(p.relationship_note).toBe('they ghost on weekends, finals stress');
  });

  it('loadProfile defaults relationship_note to empty string when absent', async () => {
    const s = makeStore();
    const p = await s.loadProfile('nobody');
    expect(p.relationship_note).toBe('');
  });
});
