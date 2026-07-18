// tests/admin/knowledge-admin.test.ts
//
// Teach george — the fact/rule WRITE layer. Pins: the server-owned type→table
// mapping + validation (client can never name a table, reserved category
// rejected), publish embeds + inserts + returns the stored row + audits, delete
// is table- and reserved-scoped with uuid validation, and the rules wrappers pin
// the reserved category on every operation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { embedText, logAdminAction, bustHouseRulesCache } = vi.hoisted(() => ({
  embedText: vi.fn(),
  logAdminAction: vi.fn(),
  bustHouseRulesCache: vi.fn(),
}));
vi.mock('../../src/tools/embed-text.js', () => ({ embedText }));
vi.mock('../../src/admin/actions.js', () => ({ logAdminAction }));
vi.mock('../../src/tools/house-rules.js', () => ({
  HOUSE_RULE_CATEGORY: '__house_rule__',
  MAX_RULES: 20,
  bustHouseRulesCache,
}));
vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import {
  normalizeFact,
  publishFact,
  listFacts,
  deleteFact,
  normalizeRule,
  publishRule,
  listRules,
  deleteRule,
} from '../../src/admin/knowledge-admin.js';

const UUID = '11111111-2222-3333-4444-555555555555';

// A per-test recording fake for the supabase fluent chain. Every method returns
// the chain; awaiting resolves to the configured result. `calls` records the
// method sequence for scoping assertions.
function fakeSb(result: { data?: unknown; error?: { message: string } | null; count?: number | null } = {}) {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const resolved = { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
  const chain: any = {};
  for (const m of ['insert', 'select', 'single', 'eq', 'neq', 'order', 'limit', 'delete']) {
    chain[m] = vi.fn((...args: unknown[]) => { calls.push({ m, args }); return chain; });
  }
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(resolved).then(res);
  const from = vi.fn((table: string) => { calls.push({ m: 'from', args: [table] }); return chain; });
  return { sb: { from } as unknown as SupabaseClient, calls, chain };
}

beforeEach(() => {
  embedText.mockReset().mockResolvedValue([0.1, 0.2]);
  logAdminAction.mockReset().mockResolvedValue(undefined);
  bustHouseRulesCache.mockReset();
});

describe('normalizeFact', () => {
  it('maps each type to its table with required-field validation', () => {
    const ok = normalizeFact({ type: 'campus_knowledge', fields: { category: 'food', title: 'K-town', content: '性价比之王' } });
    expect(ok).toMatchObject({ ok: true, table: 'campus_knowledge', row: { category: 'food', title: 'K-town' } });
    const miss = normalizeFact({ type: 'freshman_faq', fields: { question: 'q?' } as any });
    expect(miss).toMatchObject({ ok: false });
    const tips = normalizeFact({ type: 'course_tips', fields: { tip: 'avoid 8am' } });
    expect(tips).toMatchObject({ ok: true, table: 'course_tips', row: { tip: 'avoid 8am' } });
  });

  it('rejects unknown types, oversized fields, and the reserved category', () => {
    expect(normalizeFact({ type: 'students' as any, fields: {} })).toMatchObject({ ok: false });
    expect(
      normalizeFact({ type: 'campus_knowledge', fields: { category: 'food', title: 'x'.repeat(300), content: 'c' } }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeFact({ type: 'campus_knowledge', fields: { category: '__house_rule__', title: 't', content: 'c' } }),
    ).toMatchObject({ ok: false, error: 'reserved category' });
  });

  it('trims fields and DROPS unknown fields (client cannot smuggle columns)', () => {
    const r = normalizeFact({
      type: 'course_tips',
      fields: { tip: '  pad  ', evil_column: 'x', course_code: 'WRIT150' } as any,
    });
    expect(r).toMatchObject({ ok: true, row: { tip: 'pad', course_code: 'WRIT150' } });
    if (r.ok) expect('evil_column' in r.row).toBe(false);
  });
});

describe('publishFact', () => {
  it('embeds, inserts into the mapped table, returns the stored row, audits', async () => {
    const stored = { id: UUID, category: 'food', title: 'K-town', content: 'c', created_at: 'now' };
    const { sb, calls } = fakeSb({ data: stored });
    const r = await publishFact(sb, { type: 'campus_knowledge', fields: { category: 'food', title: 'K-town', content: 'c' } }, 'bobby@usc.edu');
    expect(r).toMatchObject({ ok: true, row: stored });
    expect(calls[0]).toEqual({ m: 'from', args: ['campus_knowledge'] });
    const insert = calls.find((c) => c.m === 'insert');
    expect(insert?.args[0]).toMatchObject({ title: 'K-town', embedding: [0.1, 0.2] });
    expect(logAdminAction).toHaveBeenCalledWith(sb, expect.objectContaining({ action: 'teach_add_fact', actor: 'bobby@usc.edu' }));
  });

  it('publishes unembedded when embedText returns null or throws', async () => {
    embedText.mockResolvedValue(null);
    const { sb, calls } = fakeSb({ data: { id: UUID } });
    await publishFact(sb, { type: 'course_tips', fields: { tip: 't' } }, 'a');
    expect(calls.find((c) => c.m === 'insert')?.args[0]).toMatchObject({ embedding: null });

    embedText.mockRejectedValue(new Error('openai down'));
    const second = fakeSb({ data: { id: UUID } });
    const r = await publishFact(second.sb, { type: 'course_tips', fields: { tip: 't' } }, 'a');
    expect(r.ok).toBe(true);
  });

  it('surfaces an insert error as ok:false (no audit)', async () => {
    const { sb } = fakeSb({ error: { message: 'insert denied' } });
    const r = await publishFact(sb, { type: 'course_tips', fields: { tip: 't' } }, 'a');
    expect(r).toMatchObject({ ok: false, error: 'insert denied' });
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe('listFacts / deleteFact', () => {
  it('lists newest-first and excludes the reserved category for campus_knowledge', async () => {
    const { sb, calls, chain } = fakeSb({ data: [{ id: UUID }] });
    const rows = await listFacts(sb, 'campus_knowledge');
    expect(rows).toEqual([{ id: UUID }]);
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(calls.some((c) => c.m === 'neq' && c.args[0] === 'category' && c.args[1] === '__house_rule__')).toBe(true);
  });

  it('does NOT add the reserved exclusion for the other tables', async () => {
    const { sb, calls } = fakeSb({ data: [] });
    await listFacts(sb, 'freshman_faq');
    expect(calls.some((c) => c.m === 'neq')).toBe(false);
  });

  it('delete validates the uuid and scopes campus_knowledge away from rules', async () => {
    expect(await deleteFact(fakeSb().sb, 'campus_knowledge', 'not-a-uuid', 'a')).toMatchObject({ ok: false });
    const { sb, calls } = fakeSb({ data: [{ id: UUID }] });
    const r = await deleteFact(sb, 'campus_knowledge', UUID, 'a');
    expect(r).toMatchObject({ ok: true, removed: 1 });
    expect(calls.some((c) => c.m === 'delete')).toBe(true);
    expect(calls.some((c) => c.m === 'neq' && c.args[1] === '__house_rule__')).toBe(true);
    expect(logAdminAction).toHaveBeenCalledWith(sb, expect.objectContaining({ action: 'teach_delete_fact' }));
  });
});

describe('rules', () => {
  it('normalizeRule requires rule text, caps lengths, defaults the label', () => {
    expect(normalizeRule({ rule: '' })).toMatchObject({ ok: false });
    expect(normalizeRule({ rule: 'x'.repeat(600) })).toMatchObject({ ok: false });
    expect(normalizeRule({ rule: '别用 emoji' })).toMatchObject({
      ok: true,
      row: { category: '__house_rule__', title: 'house rule', content: '别用 emoji' },
    });
  });

  it('publishRule pins the reserved category, busts the cache, audits', async () => {
    const { sb, calls } = fakeSb({ data: { id: UUID }, count: 0 });
    const r = await publishRule(sb, { label: 'tone', rule: '别用 emoji' }, 'bobby@usc.edu');
    expect(r.ok).toBe(true);
    const insert = calls.find((c) => c.m === 'insert');
    expect(insert?.args[0]).toMatchObject({ category: '__house_rule__', content: '别用 emoji', embedding: null });
    expect(bustHouseRulesCache).toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledWith(sb, expect.objectContaining({ action: 'teach_add_rule' }));
  });

  it('publishRule refuses past the rule cap', async () => {
    const { sb } = fakeSb({ data: { id: UUID }, count: 20 });
    const r = await publishRule(sb, { rule: 'one more' }, 'a');
    expect(r).toMatchObject({ ok: false });
    expect(bustHouseRulesCache).not.toHaveBeenCalled();
  });

  it('listRules/deleteRule stay inside the reserved category', async () => {
    const l = fakeSb({ data: [{ id: UUID }] });
    await listRules(l.sb);
    expect(l.calls.some((c) => c.m === 'eq' && c.args[1] === '__house_rule__')).toBe(true);

    const d = fakeSb({ data: [{ id: UUID }] });
    const r = await deleteRule(d.sb, UUID, 'a');
    expect(r).toMatchObject({ ok: true, removed: 1 });
    expect(d.calls.some((c) => c.m === 'eq' && c.args[1] === '__house_rule__')).toBe(true);
    expect(bustHouseRulesCache).toHaveBeenCalled();
  });
});
