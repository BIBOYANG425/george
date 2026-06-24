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

// Resolve a channel handle to its students.id, creating the row when absent.
//
// iMessage (phone) handles route the CREATE through the reconcile_identity RPC
// (spec §6/§7): george never directly inserts a phone-keyed students row — instead
// the single, atomic merge primitive creates the row keyed by canonical phone, so a
// later web signup with the same phone/email MERGES into it rather than forking a
// second identity (the +86→+853 disease). reconcile_identity doesn't set
// referral_code, so we backfill it idempotently to keep parity with the legacy
// insert. WeChat openids are outside reconcile_identity's phone-first scope and keep
// the direct insert. If the RPC is unavailable (e.g. the migration isn't applied in
// this environment), iMessage falls back to the legacy insert so george keeps
// working. `sb` injectable for tests.
export async function resolveStudentId(
  userId: string,
  platform: 'wechat' | 'imessage',
  sb: SupabaseClient = supabase,
): Promise<string> {
  const column = platform === 'wechat' ? 'wechat_open_id' : 'imessage_id'
  const { data } = await sb
    .from('students')
    .select('id')
    .eq(column, userId)
    .single()

  if (data) return data.id

  // iMessage miss → get/create the canonical row via reconcile_identity.
  if (platform === 'imessage') {
    const reconciledId = await reconcileStudentByPhone(userId, sb)
    if (reconciledId) {
      await ensureReferralCode(reconciledId, sb)
      return reconciledId
    }
    // RPC unavailable in this env → fall through to the legacy insert below.
  }

  // Legacy race-safe create (WeChat, or iMessage when the RPC is absent): two
  // concurrent messages from the same new user both miss the SELECT above and both
  // try to INSERT. The second hits the unique constraint on the platform id column,
  // the insert returns null, so on insert failure we re-SELECT since the other
  // request presumably created the row.
  const referralCode = randomReferralCode()
  const { data: newStudent, error: insertError } = await sb
    .from('students')
    .insert({ [column]: userId, referral_code: referralCode })
    .select('id')
    .single()

  if (newStudent) return newStudent.id

  const { data: recovered } = await sb
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

// Get/create the canonical students row for a canonical E.164 phone via the atomic,
// idempotent reconcile_identity RPC. Returns students.id, or null when the RPC is
// unavailable (function-not-found / transient error / empty result) so the caller
// can fall back to a direct insert. The handle is already canonical E.164 from
// normalizeHandle upstream; the RPC is the only path that creates a phone-keyed row.
async function reconcileStudentByPhone(
  phoneE164: string,
  sb: SupabaseClient,
): Promise<string | null> {
  try {
    const { data, error } = await sb.rpc('reconcile_identity', { p_phone_e164: phoneE164 })
    if (error) return null
    // reconcile_identity is `returns table(student_id, user_id)` → an array of rows.
    const row = Array.isArray(data) ? data[0] : data
    return (row as { student_id?: string } | null | undefined)?.student_id ?? null
  } catch {
    return null
  }
}

// Backfill referral_code on a reconcile-created student that has none. The
// `.is('referral_code', null)` guard makes it idempotent: it never clobbers an
// existing code and is a no-op once set. A rare unique collision just leaves the
// code null (same as reconcile_identity's own default), never an error to the caller.
async function ensureReferralCode(studentId: string, sb: SupabaseClient): Promise<void> {
  await sb
    .from('students')
    .update({ referral_code: randomReferralCode() })
    .eq('id', studentId)
    .is('referral_code', null)
}

function randomReferralCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
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
