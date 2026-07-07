// tests/scripts/ingest-catalogue.test.ts
// Unit tests for fetchAllPaged — the PostgREST paging helper that walks a
// .range(from, to) select past the default 1000-row cap. Fakes the page runner
// (no Supabase, no network). Covers: single short page, multi-page walk, the
// exactly-N*1000 boundary (needs the trailing empty page), .range window args,
// and error propagation.
import { describe, it, expect } from 'vitest';
import { fetchAllPaged, PAGE_SIZE } from '../../scripts/ingest-catalogue.js';

type Row = { id: number };

// A fake page runner backed by an in-memory array. Records the (from,to) windows
// it was asked for so we can assert the helper pages in PAGE_SIZE steps.
function makeRunner(total: number) {
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  const windows: Array<[number, number]> = [];
  const runPage = async (from: number, to: number) => {
    windows.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { runPage, windows };
}

describe('fetchAllPaged', () => {
  it('PAGE_SIZE is the PostgREST default cap', () => {
    expect(PAGE_SIZE).toBe(1000);
  });

  it('returns all rows from a single short page and stops after one call', async () => {
    const { runPage, windows } = makeRunner(3);
    const rows = await fetchAllPaged<Row>(runPage);
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(windows).toEqual([[0, 999]]);
  });

  it('returns [] for an empty table without a second call', async () => {
    const { runPage, windows } = makeRunner(0);
    const rows = await fetchAllPaged<Row>(runPage);
    expect(rows).toEqual([]);
    expect(windows).toEqual([[0, 999]]);
  });

  it('walks multiple pages and requests correct PAGE_SIZE windows', async () => {
    const { runPage, windows } = makeRunner(2500);
    const rows = await fetchAllPaged<Row>(runPage);
    expect(rows).toHaveLength(2500);
    expect(rows[0].id).toBe(0);
    expect(rows[2499].id).toBe(2499);
    // 3 pages: [0..999], [1000..1999], [2000..2999] (last returns 500 → stop)
    expect(windows).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('at an exact multiple of PAGE_SIZE, makes a trailing call that returns empty and stops', async () => {
    const { runPage, windows } = makeRunner(2000);
    const rows = await fetchAllPaged<Row>(runPage);
    expect(rows).toHaveLength(2000);
    // A full 1000-row page can never signal "done" on its own, so the helper must
    // fetch once more; that page comes back empty and terminates the loop.
    expect(windows).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('treats a null data page as the end', async () => {
    let calls = 0;
    const rows = await fetchAllPaged<Row>(async () => {
      calls++;
      return { data: null, error: null };
    });
    expect(rows).toEqual([]);
    expect(calls).toBe(1);
  });

  it('throws when a page returns an error', async () => {
    const boom = { message: 'permission denied' };
    await expect(
      fetchAllPaged<Row>(async () => ({ data: null, error: boom })),
    ).rejects.toBe(boom);
  });
});
