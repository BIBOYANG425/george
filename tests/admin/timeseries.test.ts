// tests/admin/timeseries.test.ts
// GG3-1: getTimeseries must bucket by LA-local calendar day (matching the overview
// cards / startOfLADayISO), not the raw UTC date. A 03:00Z turn is the PREVIOUS LA
// day (19:00-20:00 local), so it must NOT land in the UTC-today bucket. DST-correct:
// the offset shifts an hour across PST/PDT, so a fixed -8 would misfile summer rows.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { laDayKey, getTimeseries } from '../../src/admin/analytics';

// Minimal messages query stub: .select().gte().order().limit() → { data }.
function mockSb(rows: Array<{ created_at: string; role: string }>): SupabaseClient {
  const builder: any = {
    select: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => ({ data: rows }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('laDayKey (LA-local calendar day)', () => {
  it('buckets a 03:00Z turn to the PREVIOUS LA day (PDT summer)', () => {
    // 2026-07-07T03:00:00Z = 2026-07-06 20:00 PDT (UTC-7) → LA date is the 6th.
    expect(laDayKey('2026-07-07T03:00:00Z')).toBe('2026-07-06');
  });
  it('is DST-correct: 07:30Z summer is the SAME LA day (a fixed -8 would misfile it)', () => {
    // 2026-07-07T07:30:00Z = 2026-07-07 00:30 PDT (UTC-7) → the 7th.
    // A naive fixed -8 offset would compute 23:30 on the 6th — wrong.
    expect(laDayKey('2026-07-07T07:30:00Z')).toBe('2026-07-07');
  });
  it('buckets a 03:00Z winter turn to the PREVIOUS LA day (PST)', () => {
    // 2026-01-15T03:00:00Z = 2026-01-14 19:00 PST (UTC-8) → the 14th.
    expect(laDayKey('2026-01-15T03:00:00Z')).toBe('2026-01-14');
  });
});

describe('getTimeseries LA-day bucketing', () => {
  afterEach(() => vi.useRealTimers());

  it('files a 03:00Z turn on the LA date, not the UTC date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z')); // LA date = 2026-07-07

    const rows = [
      { created_at: '2026-07-07T03:00:00Z', role: 'user' }, // LA 2026-07-06 20:00
      { created_at: '2026-07-07T12:00:00Z', role: 'assistant' }, // LA 2026-07-07 05:00
    ];
    const out = await getTimeseries(mockSb(rows), 14);

    expect(out).toHaveLength(14);
    expect(out[out.length - 1].date).toBe('2026-07-07'); // window ends on LA today

    const d6 = out.find((b) => b.date === '2026-07-06');
    const d7 = out.find((b) => b.date === '2026-07-07');
    expect(d6).toEqual({ date: '2026-07-06', user: 1, assistant: 0, total: 1 });
    expect(d7).toEqual({ date: '2026-07-07', user: 0, assistant: 1, total: 1 });
    // The 03:00Z user turn must NOT be counted on the UTC date (2026-07-07).
    expect(d7!.user).toBe(0);
  });
});
