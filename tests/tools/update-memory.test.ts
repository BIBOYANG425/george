// tests/tools/update-memory.test.ts
// The deliberate update_memory WRITE tool. Mirrors recall-memory.test.ts: fake
// ProfileStore + mocked resolve/consent, zero network. Asserts: a grounded fact
// appends to the right block (resolving handle → uuid); invalid block / empty fact
// / non-onboarded handle / withheld consent → graceful "not saved" no-op; never
// throws. Gating (tool present/absent by flag) lives in update-memory-gating.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';

// The lazy default builds a real service-role client; @supabase/supabase-js
// validates the URL at construction. Dummies keep import-time construction safe.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import {
  updateMemoryHandler,
  isUpdateMemoryToolEnabled,
  type UpdateMemoryDeps,
} from '../../src/tools/update-memory.js';

const HANDLE = '+17474638880';
const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// Fake ProfileStore recording appendToBlock calls; resolve→UID, consent→true.
function deps(over: Partial<UpdateMemoryDeps> = {}): {
  d: UpdateMemoryDeps;
  appends: Array<{ userId: string; block: string; addition: string }>;
  resolve: ReturnType<typeof vi.fn>;
  consent: ReturnType<typeof vi.fn>;
} {
  const appends: Array<{ userId: string; block: string; addition: string }> = [];
  const store = {
    async appendToBlock(userId: string, block: string, addition: string) {
      appends.push({ userId, block, addition });
    },
  } as unknown as UpdateMemoryDeps['store'];
  const resolve = vi.fn(async () => UID);
  const consent = vi.fn(async () => true);
  return { d: { store, resolve, consent, ...over }, appends, resolve, consent };
}

describe('isUpdateMemoryToolEnabled', () => {
  const orig = process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
    else process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED = orig;
  });
  it('reflects GEORGE_UPDATE_MEMORY_TOOL_ENABLED === "true" exactly', () => {
    delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
    expect(isUpdateMemoryToolEnabled()).toBe(false);
    process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED = 'true';
    expect(isUpdateMemoryToolEnabled()).toBe(true);
    process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED = '1';
    expect(isUpdateMemoryToolEnabled()).toBe(false);
  });
});

describe('updateMemoryHandler — happy path', () => {
  it('appends a fact to the resolved uuid + block, returns saved:true', async () => {
    const { d, appends, resolve, consent } = deps();
    const out = await updateMemoryHandler({ block: 'academic', fact: '  switched major to CS, junior  ', user_id: HANDLE }, d);
    expect(JSON.parse(out)).toEqual({ saved: true, block: 'academic', fact: 'switched major to CS, junior' });
    expect(resolve).toHaveBeenCalledWith(HANDLE);
    expect(consent).toHaveBeenCalledWith(UID);
    expect(appends).toEqual([{ userId: UID, block: 'academic', addition: 'switched major to CS, junior' }]);
  });
});

describe('updateMemoryHandler — graceful no-ops (never throws, no write)', () => {
  it('invalid block → not saved, no append', async () => {
    const { d, appends } = deps();
    const out = await updateMemoryHandler({ block: 'george_notes', fact: 'x', user_id: HANDLE }, d);
    expect(JSON.parse(out).saved).toBe(false); // george_notes excluded from DURABLE_FACT_BLOCKS
    expect(appends).toEqual([]);
  });

  it('unknown block → not saved', async () => {
    const { d, appends } = deps();
    expect(JSON.parse(await updateMemoryHandler({ block: 'nonsense', fact: 'x', user_id: HANDLE }, d)).saved).toBe(false);
    expect(appends).toEqual([]);
  });

  it('empty / whitespace fact → not saved, no resolve', async () => {
    const { d, appends, resolve } = deps();
    expect(JSON.parse(await updateMemoryHandler({ block: 'academic', fact: '   ', user_id: HANDLE }, d)).saved).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  });

  it('missing user_id → not saved', async () => {
    const { d, appends } = deps();
    expect(JSON.parse(await updateMemoryHandler({ block: 'academic', fact: 'studies CS' }, d)).saved).toBe(false);
    expect(appends).toEqual([]);
  });

  it('non-onboarded handle (resolve → null) → not saved, no consent check, no append', async () => {
    const { d, appends, consent } = deps({ resolve: vi.fn(async () => null) });
    expect(JSON.parse(await updateMemoryHandler({ block: 'academic', fact: 'studies CS', user_id: HANDLE }, d)).saved).toBe(false);
    expect(consent).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  });

  it('consent withheld → not saved, no append (PII gate)', async () => {
    const { d, appends } = deps({ consent: vi.fn(async () => false) });
    expect(JSON.parse(await updateMemoryHandler({ block: 'academic', fact: 'studies CS', user_id: HANDLE }, d)).saved).toBe(false);
    expect(appends).toEqual([]);
  });

  it('appendToBlock throws → not saved (no throw)', async () => {
    const store = { async appendToBlock() { throw new Error('rpc exploded'); } } as unknown as UpdateMemoryDeps['store'];
    const d: UpdateMemoryDeps = { store, resolve: vi.fn(async () => UID), consent: vi.fn(async () => true) };
    await expect(updateMemoryHandler({ block: 'academic', fact: 'studies CS', user_id: HANDLE }, d)).resolves.toContain('saved');
    expect(JSON.parse(await updateMemoryHandler({ block: 'academic', fact: 'studies CS', user_id: HANDLE }, d)).saved).toBe(false);
  });

  it('resolve throws → not saved (no throw)', async () => {
    const d: UpdateMemoryDeps = { resolve: vi.fn(async () => { throw new Error('db down'); }) };
    expect(JSON.parse(await updateMemoryHandler({ block: 'academic', fact: 'studies CS', user_id: HANDLE }, d)).saved).toBe(false);
  });
});
