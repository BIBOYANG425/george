// tests/admin/overview-coverage.test.ts
// GG3-2: telemetry coverage must be honest. Only assistant turns carry tokens_used,
// so the numerator (token-bearing rows) MUST be scoped to role=assistant — the same
// filter getSystemHealth uses — or the fraction's numerator and denominator would
// count different row populations (all-messages numerator over assistant denominator
// structurally overstates coverage). This pins the numerator role filter.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOverview } from '../../src/admin/analytics';

// Records every query's filter chain and resolves head counts from the recorded ops.
// numerator (assistant + tokens_used not null) → 40; assistant total → 50 → 80%.
function overviewSb() {
  const chains: string[][] = [];
  function resolve(table: string, ops: string[]) {
    const hasGte = ops.some((o) => o.startsWith('gte:'));
    let count = 0;
    if (table === 'messages' && ops.includes('eq:role=assistant') && ops.includes('not:tokens_used')) count = 40;
    else if (table === 'messages' && ops.includes('eq:role=assistant') && !hasGte) count = 50;
    return { count, data: [] as unknown[] };
  }
  const sb = {
    from(table: string) {
      const ops: string[] = [];
      chains.push(ops);
      const b: any = {
        select: () => (ops.push('select'), b),
        gte: (c: string) => (ops.push('gte:' + c), b),
        eq: (c: string, v: unknown) => (ops.push('eq:' + c + '=' + v), b),
        not: (c: string) => (ops.push('not:' + c), b),
        order: () => (ops.push('order'), b),
        limit: () => (ops.push('limit'), b),
        then: (res: (v: unknown) => void) => res(resolve(table, ops)),
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { sb, chains };
}

describe('getOverview telemetry coverage numerator', () => {
  it('scopes the token-bearing count to role=assistant (matches getSystemHealth)', async () => {
    const { sb, chains } = overviewSb();
    const o = await getOverview(sb);

    // Every query that filters tokens_used-not-null must ALSO filter role=assistant.
    const tokenChains = chains.filter((ops) => ops.includes('not:tokens_used'));
    expect(tokenChains.length).toBeGreaterThan(0);
    for (const ops of tokenChains) expect(ops).toContain('eq:role=assistant');

    // Numerator (40) / assistant denominator (50) = 80%; both exposed for the UI
    // fraction so the printed "40/50" uses the SAME denominator as the percentage.
    expect(o.telemetry.messagesWithTokens).toBe(40);
    expect(o.telemetry.assistantMessages).toBe(50);
    expect(o.telemetry.coveragePct).toBe(80);
  });
});
