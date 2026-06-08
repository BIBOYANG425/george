// tests/onboarding/pending-users.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPendingUser, lookupByCode, markCompleted, cleanupOld } from '../../src/onboarding/pending-users.js';

function mockSupabase() {
  const rows: any[] = [];
  return {
    rows,
    from(table: string) {
      return {
        insert: vi.fn(async (row: any) => { rows.push({ ...row, table }); return { error: null }; }),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({ data: rows.find(r => r.table === table) ?? null, error: null })),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
      } as any;
    },
  };
}

describe('createPendingUser', () => {
  it('inserts a new pending_users row', async () => {
    const supabase = mockSupabase();
    await createPendingUser(supabase as any, 'g7k2m4');
    expect(supabase.rows[0]).toMatchObject({ code: 'g7k2m4', status: 'pending' });
  });
});

describe('lookupByCode', () => {
  it('returns null for missing code', async () => {
    const supabase = mockSupabase();
    const result = await lookupByCode(supabase as any, 'nope12');
    expect(result).toBeNull();
  });
});
