import { supabase } from './client.js'
import type { SupabaseClient } from '@supabase/supabase-js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    if (data?.user_id) return data.user_id as string
  }
  return null
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

export async function loadStudentMemories(studentId: string, limit = 20) {
  const { data } = await supabase
    .from('student_memories')
    .select('key, value, category')
    .eq('student_id', studentId)
    .order('last_referenced_at', { ascending: false })
    .limit(limit)
  return data || []
}

export async function getReferralCount(studentId: string): Promise<number> {
  const { count } = await supabase
    .from('students')
    .select('id', { count: 'exact', head: true })
    .eq('referred_by', studentId)
  return count || 0
}
