import { supabase } from './client.js'
import type { SupabaseClient } from '@supabase/supabase-js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Short-TTL memo for handle→user_id. The mapping is effectively immutable for a
// student (a handle binds to one account at onboarding and doesn't churn), and
// resolveProfileUserId now sits on the per-turn memory-capture hot path, so a
// few-minute cache removes a redundant `students` round-trip every turn. Only
// POSITIVE resolutions are cached — a null (not-yet-onboarded handle) is always
// re-queried, so a student who onboards mid-session isn't stuck invisible. uuid
// pass-throughs never reach the cache (there's no query to save).
const RESOLVE_TTL_MS = 5 * 60_000
// Partitioned by the Supabase client instance (WeakMap), NOT a flat handle→uuid
// Map: in production there's one `supabase` client so it behaves as a single cache,
// but an injected test/fake client gets its OWN partition — so a cached resolution
// from one client can never be returned for a different client querying the same
// handle (the silent-`sb`-bypass codex flagged).
let resolveCache = new WeakMap<SupabaseClient, Map<string, { uuid: string; expiresAt: number }>>()

// Test-only: drop the memo so a fresh fake `sb` isn't shadowed by a prior test's
// cached resolution. Not used in production.
export function __resetResolveProfileCache(): void {
  resolveCache = new WeakMap()
}

// Resolve a channel handle (phone / wechat openid) to the student's `user_id` —
// the uuid that `user_profiles` is keyed by. The conversation path only ever has
// the handle (e.g. "+17474638880"), but user_profiles.user_id is students.user_id
// (a uuid), so loading/saving memory by the raw handle always misses. This bridges
// the two. Returns null when there's no onboarded student behind the handle (no
// uuid → no profile). An already-uuid input is passed through (heartbeat already
// keys by uuid). `sb` is injectable for tests.
export async function resolveProfileUserId(
  handle: string,
  sb: SupabaseClient = supabase,
): Promise<string | null> {
  if (!handle) return null
  if (UUID_RE.test(handle)) return handle
  let perClient = resolveCache.get(sb)
  const cached = perClient?.get(handle)
  if (cached && cached.expiresAt > Date.now()) return cached.uuid
  // Two scoped equality lookups (never interpolate the handle into an .or() filter,
  // and never .eq the uuid user_id column with a phone string — that throws).
  for (const column of ['imessage_id', 'wechat_open_id'] as const) {
    const { data } = await sb
      .from('students')
      .select('user_id')
      .eq(column, handle)
      .not('user_id', 'is', null)
      .limit(1)
      .maybeSingle()
    if (data?.user_id) {
      const uuid = data.user_id as string
      if (!perClient) {
        perClient = new Map()
        resolveCache.set(sb, perClient)
      }
      perClient.set(handle, { uuid, expiresAt: Date.now() + RESOLVE_TTL_MS })
      return uuid
    }
  }
  return null
}

// Whether the student behind this resolved user_id (uuid) has consented to
// long-term memory writes — the per-turn capturer AND the update_memory tool both
// gate on it before persisting any fact to user_profiles. Mirrors the heartbeat's
// consent_proactive_messages gate. FAIL-CLOSED: any miss returns false — no config
// row, a null value, the consent_memory column not yet migrated in bia-admin, or a
// read error — so George never writes PII to a profile without an explicit opt-in.
// `select('*')` (not the named column) is deliberate: a not-yet-migrated column is
// then simply absent from the row rather than a PostgREST "column does not exist"
// error. `id` must already be a students.user_id (uuid); `sb` injectable for tests.
export async function getMemoryConsent(
  id: string,
  sb: SupabaseClient = supabase,
): Promise<boolean> {
  if (!id) return false
  try {
    const { data, error } = await sb
      .from('user_heartbeat_config')
      .select('*')
      .eq('user_id', id)
      .maybeSingle()
    if (error) return false
    return (data as { consent_memory?: boolean } | null)?.consent_memory === true
  } catch {
    return false
  }
}

export async function getStudentById(id: string) {
  const { data } = await supabase.from('students').select('*').eq('id', id).single()
  return data
}

export async function updateStudent(id: string, updates: Record<string, unknown>) {
  await supabase
    .from('students')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
}

// Flip the shipping-notification opt-out flag for the student behind a channel
// handle. Does NOT create a student — a bare "TD" from an unknown handle is a
// no-op. Returns whether a matching student row was updated. `sb` injectable for
// tests.
export async function setShippingNotifOptOut(
  userId: string,
  platform: 'wechat' | 'imessage',
  optOut: boolean,
  sb: SupabaseClient = supabase,
): Promise<boolean> {
  const column = platform === 'wechat' ? 'wechat_open_id' : 'imessage_id'
  const { data } = await sb
    .from('students')
    .update({ shipping_notif_opt_out: optOut, updated_at: new Date().toISOString() })
    .eq(column, userId)
    .select('id')
  return Array.isArray(data) && data.length > 0
}

export async function resolveStudentId(userId: string, platform: 'wechat' | 'imessage'): Promise<string> {
  const column = platform === 'wechat' ? 'wechat_open_id' : 'imessage_id'
  const { data } = await supabase
    .from('students')
    .select('id')
    .eq(column, userId)
    .single()

  if (data) return data.id

  // Race-safe create: two concurrent messages from the same new user both
  // miss the SELECT above and both try to INSERT. The second one hits the
  // unique constraint on the platform id column, the insert returns null,
  // and the old `newStudent!.id` crashed with TypeError. On insert failure
  // we re-SELECT since the other request presumably created the row.
  const referralCode = Math.random().toString(36).slice(2, 8).toUpperCase()
  const { data: newStudent, error: insertError } = await supabase
    .from('students')
    .insert({ [column]: userId, referral_code: referralCode })
    .select('id')
    .single()

  if (newStudent) return newStudent.id

  const { data: recovered } = await supabase
    .from('students')
    .select('id')
    .eq(column, userId)
    .single()

  if (recovered) return recovered.id

  throw new Error(
    `resolveStudentId failed for ${platform}:${userId.slice(0, 8)}…: ${
      insertError?.message ?? 'unknown insert error'
    }`,
  )
}

export async function generateLinkCode(studentId: string): Promise<string> {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  await supabase
    .from('students')
    .update({ link_code: code, link_code_expires_at: expiresAt })
    .eq('id', studentId)
  return code
}

export async function claimLinkCode(
  code: string,
  claimingStudentId: string,
  claimingPlatform: 'wechat' | 'imessage',
): Promise<{ success: boolean; message: string }> {
  const { data: target } = await supabase
    .from('students')
    .select('id, wechat_open_id, imessage_id, link_code_expires_at')
    .eq('link_code', code)
    .single()

  if (!target) return { success: false, message: '验证码不存在' }
  if (new Date(target.link_code_expires_at) < new Date()) {
    return { success: false, message: '验证码已过期' }
  }
  if (target.id === claimingStudentId) {
    return { success: false, message: '不能链接自己的账号' }
  }

  const { data: claimer } = await supabase
    .from('students')
    .select('wechat_open_id, imessage_id')
    .eq('id', claimingStudentId)
    .single()

  if (!claimer) return { success: false, message: '找不到你的账号' }

  const platformColumn = claimingPlatform === 'wechat' ? 'wechat_open_id' : 'imessage_id'
  const platformValue = claimer[platformColumn]

  await Promise.all([
    supabase
      .from('students')
      .update({ [platformColumn]: platformValue, link_code: null, link_code_expires_at: null })
      .eq('id', target.id),
    supabase
      .from('messages')
      .update({ student_id: target.id })
      .eq('student_id', claimingStudentId),
  ])
  await supabase.from('students').delete().eq('id', claimingStudentId)

  return { success: true, message: '账号链接成功！现在你的微信和iMessage是同一个George了 👻' }
}

export async function getReferralCount(studentId: string): Promise<number> {
  const { count } = await supabase
    .from('students')
    .select('id', { count: 'exact', head: true })
    .eq('referred_by', studentId)
  return count || 0
}
