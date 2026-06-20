// tests/db/students.test.ts
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveProfileUserId } from '../../src/db/students'

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
