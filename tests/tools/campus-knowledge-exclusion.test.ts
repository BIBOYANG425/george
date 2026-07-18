// tests/tools/campus-knowledge-exclusion.test.ts
//
// Teach george — the reserved HOUSE_RULE_CATEGORY must never surface from the
// campus_knowledge fact search. Pins: with GEORGE_TEACH_ENABLED the keyword query
// carries .neq(category, __house_rule__); with the flag OFF the query chain is
// byte-identical to pre-feature behavior (NO neq call — the exclusion itself is
// flag-gated).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ supabase: { from: fromMock } }));

import { campusKnowledgeHandler } from '../../src/tools/campus-knowledge.js';
import { HOUSE_RULE_CATEGORY } from '../../src/tools/house-rules.js';

// Recording chain: every filter method returns the chain; textSearch/or resolve
// (thenable) to the configured result so searchWithFallback can await them.
function fakeChain(rows: unknown[]) {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const chain: any = {};
  for (const m of ['select', 'limit', 'eq', 'neq', 'ilike', 'or', 'textSearch']) {
    chain[m] = vi.fn((...args: unknown[]) => { calls.push({ m, args }); return chain; });
  }
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
  return { chain, calls };
}

let savedTeach: string | undefined;
beforeEach(() => {
  savedTeach = process.env.GEORGE_TEACH_ENABLED;
  delete process.env.GEORGE_TEACH_ENABLED;
  fromMock.mockReset();
});
afterEach(() => {
  if (savedTeach === undefined) delete process.env.GEORGE_TEACH_ENABLED;
  else process.env.GEORGE_TEACH_ENABLED = savedTeach;
});

describe('campus_knowledge fact search vs house rules', () => {
  it('flag ON → the query excludes the reserved category', async () => {
    process.env.GEORGE_TEACH_ENABLED = 'true';
    const { chain, calls } = fakeChain([{ title: 't', content: 'c', category: 'food' }]);
    fromMock.mockReturnValue(chain);
    await campusKnowledgeHandler({ query: 'leavey' });
    expect(calls.some((c) => c.m === 'neq' && c.args[0] === 'category' && c.args[1] === HOUSE_RULE_CATEGORY)).toBe(true);
  });

  it('flag OFF → NO neq call (query chain byte-identical to pre-feature)', async () => {
    const { chain, calls } = fakeChain([{ title: 't', content: 'c', category: 'food' }]);
    fromMock.mockReturnValue(chain);
    await campusKnowledgeHandler({ query: 'leavey' });
    expect(calls.some((c) => c.m === 'neq')).toBe(false);
  });

  it('flag ON + category filter → both eq(category) and neq(reserved) apply', async () => {
    process.env.GEORGE_TEACH_ENABLED = 'true';
    const { chain, calls } = fakeChain([{ title: 't', content: 'c', category: 'food' }]);
    fromMock.mockReturnValue(chain);
    await campusKnowledgeHandler({ query: 'korean food', category: 'food' });
    expect(calls.some((c) => c.m === 'eq' && c.args[1] === 'food')).toBe(true);
    expect(calls.some((c) => c.m === 'neq' && c.args[1] === HOUSE_RULE_CATEGORY)).toBe(true);
  });
});
