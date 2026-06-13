// src/tools/pings-command.ts
// Cloud-safe /pings on|off command handler. Does NOT gate on HEARTBEAT_ENABLED.
// Wired into spectrum.ts buildTextHandler BEFORE tryHandleUserCommand so it
// works on Railway where the heartbeat runtime is never initialized.

import { supabase } from '../db/client.js'
import { resolveStudentId } from '../db/students.js'
import { log } from '../observability/logger.js'

const PINGS_RX = /^\/pings\s+(on|off)\s*$/i

/**
 * Try to handle a /pings on|off command.
 * Returns the reply string if it was a pings command; null otherwise.
 */
export async function tryPingsCommand(userId: string, text: string): Promise<string | null> {
  const trimmed = text.trim()
  const match = PINGS_RX.exec(trimmed)
  if (!match) return null

  const enabled = match[1].toLowerCase() === 'on'

  // Resolve UUID — provision the student row if needed
  const studentId = await resolveStudentId(userId, 'imessage')

  const { error } = await supabase
    .from('user_match_prefs')
    .upsert({ student_id: studentId, pings_enabled: enabled }, { onConflict: 'student_id' })

  // Only confirm if the preference actually persisted — otherwise the user
  // thinks they opted in/out when nothing changed.
  if (error) {
    log('error', 'pings_command_upsert_failed', { enabled, error: error.message })
    return '诶 设置没存上 等下再试一次哈'
  }

  if (enabled) {
    return '包的 有对的局我喊你'
  }
  return '收到 不打扰'
}
