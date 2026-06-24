// tests/db/students.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveProfileUserId,
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
