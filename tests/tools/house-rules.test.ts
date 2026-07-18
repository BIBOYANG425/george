// tests/tools/house-rules.test.ts
//
// Teach george — HOUSE RULES read path. Pins the four invariants:
//   1. Flag OFF → loadHouseRules returns '' BEFORE any DB work (byte-identity).
//   2. ON → renders header + "- rule" lines in insertion order, bounded by
//      MAX_RULES and the char cap (whole lines only, header+1 guaranteed).
//   3. 60s TTL cache + bustHouseRulesCache force-refresh.
//   4. Never throws: any DB failure → '' (a rules read can never block a reply).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ supabase: { from: fromMock } }));
vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import {
  loadHouseRules,
  renderHouseRules,
  bustHouseRulesCache,
  HOUSE_RULE_CATEGORY,
  MAX_RULES,
} from '../../src/tools/house-rules.js';

// Chainable select fake resolving to { data, error }.
function fakeSelect(data: unknown, error: { message: string } | null = null) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve({ data, error })),
  };
  return chain;
}

let savedTeach: string | undefined;
beforeEach(() => {
  savedTeach = process.env.GEORGE_TEACH_ENABLED;
  delete process.env.GEORGE_TEACH_ENABLED;
  fromMock.mockReset();
  bustHouseRulesCache();
});
afterEach(() => {
  if (savedTeach === undefined) delete process.env.GEORGE_TEACH_ENABLED;
  else process.env.GEORGE_TEACH_ENABLED = savedTeach;
  bustHouseRulesCache();
});

describe('renderHouseRules', () => {
  it('renders header + one dash line per rule, in order', () => {
    const block = renderHouseRules(['no emoji unless the user uses one', '回复别超过三行']);
    expect(block).toContain('# HOUSE RULES');
    expect(block).toContain('- no emoji unless the user uses one');
    expect(block.indexOf('no emoji')).toBeLessThan(block.indexOf('回复别超过三行'));
  });

  it('returns "" for no rules / blank rules', () => {
    expect(renderHouseRules([])).toBe('');
    expect(renderHouseRules(['  ', ''])).toBe('');
  });

  it('caps at MAX_RULES rows and the char cap (whole lines, header+1 kept)', () => {
    const many = Array.from({ length: MAX_RULES + 10 }, (_, i) => `rule ${i}`);
    const capped = renderHouseRules(many);
    expect(capped.split('\n').length - 1).toBeLessThanOrEqual(MAX_RULES);
    // one huge rule still renders (header + 1 line guarantee)
    const huge = renderHouseRules(['x'.repeat(5000)]);
    expect(huge).toContain('# HOUSE RULES');
    expect(huge).toContain('- xxx');
    // a second line after a huge first is dropped by the char cap
    const twoHuge = renderHouseRules(['x'.repeat(5000), 'second']);
    expect(twoHuge).not.toContain('- second');
  });
});

describe('loadHouseRules', () => {
  it('flag OFF → "" with ZERO DB work', async () => {
    expect(await loadHouseRules()).toBe('');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('flag ON → reads the reserved category and renders the block', async () => {
    process.env.GEORGE_TEACH_ENABLED = 'true';
    const chain = fakeSelect([{ content: 'rule A' }, { content: 'rule B' }]);
    fromMock.mockReturnValue(chain);
    const block = await loadHouseRules();
    expect(block).toContain('# HOUSE RULES');
    expect(block).toContain('- rule A');
    expect(fromMock).toHaveBeenCalledWith('campus_knowledge');
    expect(chain.eq).toHaveBeenCalledWith('category', HOUSE_RULE_CATEGORY);
  });

  it('caches within the TTL; bustHouseRulesCache forces a re-read', async () => {
    process.env.GEORGE_TEACH_ENABLED = 'true';
    fromMock.mockReturnValue(fakeSelect([{ content: 'v1' }]));
    expect(await loadHouseRules()).toContain('- v1');
    fromMock.mockReturnValue(fakeSelect([{ content: 'v2' }]));
    expect(await loadHouseRules()).toContain('- v1'); // cached
    expect(fromMock).toHaveBeenCalledTimes(1);
    bustHouseRulesCache();
    expect(await loadHouseRules()).toContain('- v2'); // fresh read
    expect(fromMock).toHaveBeenCalledTimes(2);
  });

  it('DB error → "" (never throws, not cached as poison)', async () => {
    process.env.GEORGE_TEACH_ENABLED = 'true';
    fromMock.mockReturnValue(fakeSelect(null, { message: 'boom' }));
    expect(await loadHouseRules()).toBe('');
  });

  it('thrown DB failure → "" (never throws)', async () => {
    process.env.GEORGE_TEACH_ENABLED = 'true';
    fromMock.mockImplementation(() => { throw new Error('down'); });
    expect(await loadHouseRules()).toBe('');
  });
});
