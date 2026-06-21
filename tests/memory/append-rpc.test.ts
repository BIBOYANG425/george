import { describe, it, expect } from 'vitest';
import { ProfileStore } from '../../src/memory/profile.js';

describe('appendToBlock atomic RPC seam', () => {
  it('appendToBlock delegates to the atomic RPC seam and invalidates cache', async () => {
    const calls: Array<[string, string, string]> = [];
    let invalidated = false;
    const db = {
      async loadRow() { return null; },
      async upsertBlock() {},
      async saveRelationshipNote() {},
      async appendBlockAtomic(u: string, b: string, a: string) { calls.push([u, b, a]); },
    };
    const cache = { get: async () => null, set: async () => {}, delete: async () => { invalidated = true; } };
    const s = new ProfileStore(db as any, cache as any);
    await s.appendToBlock('u1', 'academic', 'studies CS, sophomore');
    expect(calls).toEqual([['u1', 'academic', 'studies CS, sophomore']]);
    expect(invalidated).toBe(true);
  });

  it('appendToBlock rejects an invalid block name and never calls the RPC', async () => {
    const calls: any[] = [];
    const db = { async loadRow(){return null;}, async upsertBlock(){}, async saveRelationshipNote(){}, async appendBlockAtomic(){calls.push(1);} };
    const cache = { get: async()=>null, set: async()=>{}, delete: async()=>{} };
    const s = new ProfileStore(db as any, cache as any);
    await expect(s.appendToBlock('u1', 'not_a_block' as any, 'x')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('appendToBlock skips empty additions (no RPC call)', async () => {
    const calls: any[] = [];
    const db = { async loadRow(){return null;}, async upsertBlock(){}, async saveRelationshipNote(){}, async appendBlockAtomic(){calls.push(1);} };
    const cache = { get: async()=>null, set: async()=>{}, delete: async()=>{} };
    const s = new ProfileStore(db as any, cache as any);
    await s.appendToBlock('u1', 'academic', '   ');
    expect(calls).toEqual([]);
  });
});
