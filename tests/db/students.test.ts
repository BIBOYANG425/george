// tests/db/students.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveProfileUserId,
  resolveStudentId,
  getMemoryConsent,
  __resetResolveProfileCache,
} from '../../src/db/students'

// Minimal chainable fake of the PostgREST builder for the columns the resolver
// touches: .from(t).select(c).eq(col,val).not(col,'is',null).limit(n).maybeSingle().
function fakeSb(students: Array<{ imessage_id?: string; wechat_open_id?: string; user_id?: string | null }>): SupabaseClient {
  return {
    from() {
      const filters: Array<(r: any) => boolean> = []
      const api: any = {
        select: () => api,
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), api),
        not: (col: string) => (filters.push((r) => r[col] != null), api),
        limit: () => api,
        maybeSingle: async () => ({ data: students.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      }
      return api
    },
  } as unknown as SupabaseClient
}

describe('resolveProfileUserId (handle → students.user_id, the user_profiles key)', () => {
  const students = [
    { imessage_id: '+17474638880', user_id: 'e1af86be-uuid' }, // Long Pengxin (onboarded)
    { imessage_id: '+15551231234', user_id: null }, // student row but not onboarded (no user_id)
    { wechat_open_id: 'wx_abc', user_id: 'cf0a027a-uuid' },
  ]

  it('resolves a phone handle to the student user_id (the bug this fixes)', async () => {
    expect(await resolveProfileUserId('+17474638880', fakeSb(students))).toBe('e1af86be-uuid')
  })

  it('resolves a wechat openid handle', async () => {
    expect(await resolveProfileUserId('wx_abc', fakeSb(students))).toBe('cf0a027a-uuid')
  })

  it('returns null for an unknown handle (no onboarded student → no profile)', async () => {
    expect(await resolveProfileUserId('+19999999999', fakeSb(students))).toBeNull()
  })

  it('returns null when the student exists but has no user_id (not onboarded)', async () => {
    expect(await resolveProfileUserId('+15551231234', fakeSb(students))).toBeNull()
  })

  it('passes a uuid through unchanged (heartbeat already keys by uuid)', async () => {
    const uuid = 'e1af86be-1234-4abc-9def-0123456789ab'
    expect(await resolveProfileUserId(uuid, fakeSb(students))).toBe(uuid)
  })

  it('returns null for an empty handle', async () => {
    expect(await resolveProfileUserId('', fakeSb(students))).toBeNull()
  })
})

// A counting fake: increments on each .from() so we can assert how many DB round
// trips a sequence of resolveProfileUserId calls actually made.
function countingSb(
  students: Array<{ imessage_id?: string; wechat_open_id?: string; user_id?: string | null }>,
  onFrom: () => void,
): SupabaseClient {
  return {
    from() {
      onFrom()
      const filters: Array<(r: any) => boolean> = []
      const api: any = {
        select: () => api,
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), api),
        not: (col: string) => (filters.push((r) => r[col] != null), api),
        limit: () => api,
        maybeSingle: async () => ({ data: students.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      }
      return api
    },
  } as unknown as SupabaseClient
}

describe('resolveProfileUserId — short-TTL memoization (per-turn hot path)', () => {
  beforeEach(() => __resetResolveProfileCache())

  it('caches a positive resolution: repeated calls for the same handle hit the DB once', async () => {
    const rows = [{ imessage_id: '+18001112222', user_id: 'memo-uuid' }]
    let fromCalls = 0
    const sb = countingSb(rows, () => fromCalls++)
    expect(await resolveProfileUserId('+18001112222', sb)).toBe('memo-uuid')
    expect(await resolveProfileUserId('+18001112222', sb)).toBe('memo-uuid')
    expect(await resolveProfileUserId('+18001112222', sb)).toBe('memo-uuid')
    expect(fromCalls).toBe(1) // first call queried; the next two were cache hits (imessage_id matches on the first column)
  })

  it('does NOT cache a null (not-onboarded) resolution — re-queries each time', async () => {
    let fromCalls = 0
    const sb = countingSb([], () => fromCalls++)
    expect(await resolveProfileUserId('+19998887777', sb)).toBeNull()
    expect(await resolveProfileUserId('+19998887777', sb)).toBeNull()
    // each miss scans both columns (2 from() calls) and is not cached → 4 total
    expect(fromCalls).toBe(4)
  })

  it('partitions the cache by client — a different sb for the same handle is never served a stale uuid', async () => {
    const sbA = countingSb([{ imessage_id: '+15550000001', user_id: 'uuid-A' }], () => {})
    const sbB = countingSb([{ imessage_id: '+15550000001', user_id: 'uuid-B' }], () => {})
    expect(await resolveProfileUserId('+15550000001', sbA)).toBe('uuid-A')
    // sbB is a different client instance → its own partition → NOT sbA's cached uuid-A
    expect(await resolveProfileUserId('+15550000001', sbB)).toBe('uuid-B')
  })
})

// Minimal chainable fake of .from(t).select('*').eq(col,val).maybeSingle() for the
// consent read. `result` is what maybeSingle resolves to.
function fakeConfigSb(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from() {
      const api: any = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => result,
      }
      return api
    },
  } as unknown as SupabaseClient
}

describe('getMemoryConsent (per-user PII consent, FAIL-CLOSED)', () => {
  it('true only when consent_memory === true', async () => {
    expect(await getMemoryConsent('uid', fakeConfigSb({ data: { consent_memory: true }, error: null }))).toBe(true)
  })

  it('false when consent_memory is false', async () => {
    expect(await getMemoryConsent('uid', fakeConfigSb({ data: { consent_memory: false }, error: null }))).toBe(false)
  })

  it('false when the column is absent (not-yet-migrated bia-admin) — row has no consent_memory field', async () => {
    expect(await getMemoryConsent('uid', fakeConfigSb({ data: { user_id: 'uid', paused: false }, error: null }))).toBe(false)
  })

  it('false when there is no config row', async () => {
    expect(await getMemoryConsent('uid', fakeConfigSb({ data: null, error: null }))).toBe(false)
  })

  it('false on a read error (fail-closed, never throws)', async () => {
    expect(await getMemoryConsent('uid', fakeConfigSb({ data: null, error: { message: 'boom' } }))).toBe(false)
  })

  it('false for an empty id without touching the DB', async () => {
    expect(await getMemoryConsent('')).toBe(false)
  })
})

// A richer fake than fakeSb: supports the resolveStudentId chains —
// .from().select().eq().single() (lookup + recovery), .rpc('reconcile_identity'),
// .from().insert().select().single(), and the awaited .from().update().eq().is()
// referral backfill (the builder is thenable). Records rpc/insert/update calls so a
// test can assert that iMessage went through reconcile_identity and never inserted
// directly.
function resolveSb(cfg: {
  existing?: { id: string } | null
  rpc?: { data?: unknown; error?: unknown }
  insert?: { data?: { id: string } | null; error?: unknown }
  recover?: { id: string } | null
}) {
  const calls = {
    rpc: [] as Array<{ name: string; params: unknown }>,
    inserts: [] as unknown[],
    updates: [] as unknown[],
  }
  let selectSingles = 0
  const sb = {
    rpc: async (name: string, params: unknown) => {
      calls.rpc.push({ name, params })
      return cfg.rpc ?? { data: null, error: { message: 'function reconcile_identity does not exist' } }
    },
    from() {
      let inserted = false
      const b: any = {
        select: () => b,
        eq: () => b,
        is: () => b,
        insert: (v: unknown) => {
          inserted = true
          calls.inserts.push(v)
          return b
        },
        update: (v: unknown) => {
          calls.updates.push(v)
          return b
        },
        single: async () => {
          if (inserted) return cfg.insert ?? { data: null, error: { message: 'insert failed' } }
          selectSingles++
          if (selectSingles === 1) {
            return { data: cfg.existing ?? null, error: cfg.existing ? null : { message: 'no rows' } }
          }
          return { data: cfg.recover ?? null, error: null }
        },
        // The referral backfill awaits the builder after .is() (no .single()).
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
  return { sb, calls }
}

describe('resolveStudentId (handle → students.id; iMessage CREATE routes through reconcile_identity)', () => {
  it('returns an existing iMessage student without calling reconcile_identity', async () => {
    const { sb, calls } = resolveSb({ existing: { id: 'existing-id' } })
    expect(await resolveStudentId('+17474638880', 'imessage', sb)).toBe('existing-id')
    expect(calls.rpc).toHaveLength(0)
    expect(calls.inserts).toHaveLength(0)
  })

  it('on an iMessage miss, creates the canonical row via reconcile_identity (never a direct insert) and backfills referral_code', async () => {
    const { sb, calls } = resolveSb({
      existing: null,
      rpc: { data: [{ student_id: 'reconciled-id', user_id: null }], error: null },
    })
    expect(await resolveStudentId('+8615522499291', 'imessage', sb)).toBe('reconciled-id')
    expect(calls.rpc).toEqual([{ name: 'reconcile_identity', params: { p_phone_e164: '+8615522499291' } }])
    expect(calls.inserts).toHaveLength(0) // george never directly inserts a phone-keyed student
    expect(calls.updates).toHaveLength(1) // referral_code backfilled
  })

  it('falls back to a direct insert when reconcile_identity is unavailable (RPC absent)', async () => {
    const { sb, calls } = resolveSb({
      existing: null,
      rpc: { data: null, error: { message: 'function public.reconcile_identity does not exist' } },
      insert: { data: { id: 'inserted-id' }, error: null },
    })
    expect(await resolveStudentId('+13105550000', 'imessage', sb)).toBe('inserted-id')
    expect(calls.rpc).toHaveLength(1) // tried the RPC first
    expect(calls.inserts).toHaveLength(1) // then fell back
  })

  it('WeChat openids do NOT route through reconcile_identity (phone-first; direct insert)', async () => {
    const { sb, calls } = resolveSb({
      existing: null,
      insert: { data: { id: 'wx-id' }, error: null },
    })
    expect(await resolveStudentId('wx_newuser', 'wechat', sb)).toBe('wx-id')
    expect(calls.rpc).toHaveLength(0)
    expect(calls.inserts).toHaveLength(1)
  })
})
