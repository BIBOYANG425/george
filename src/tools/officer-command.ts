// src/tools/officer-command.ts
// Cloud-safe "/ok <id>" and "/no <id>" officer approve/reject for the concierge match glance.
// Mirrors pings-command.ts: wired into spectrum.ts buildTextHandler's tryUserCommand chain BEFORE
// tryHandleUserCommand, so it works on Railway where the heartbeat runtime is never initialized.
//
// Identity gate: ONLY the configured officer handle (CONCIERGE_OFFICER_IMESSAGE, normalized) may use
// it. A non-officer sender falls through (returns null) so the command's existence isn't revealed.
// <id> is the 8-char short prefix George texts the officer in the notify.

import { supabase } from '../db/client.js'
import { config } from '../config.js'
import { normalizeHandle } from '../services/phone-handle.js'
import { buildProposalDeps } from '../services/match-proposal-deps.js'
import { sendApprovedMatch, rejectMatch } from '../services/match-proposal-engine.js'

// Leading slash optional: the officer-notify text says "ok <id>" / "no <id>" (no slash), and an
// officer typing either "ok 1a2b" or "/ok 1a2b" must work.
const OFFICER_RX = /^\/?(ok|no)\s+(\S+)\s*$/i

// Find the single pending proposal whose id starts with the given short prefix. Done in JS (uuid
// columns don't support LIKE) over a bounded recent-pending window. Returns null on 0 or >1 matches.
async function resolvePendingByPrefix(prefix: string): Promise<{ id: string; post_id: string } | null> {
  const p = prefix.toLowerCase()
  const { data, error } = await supabase
    .from('proposed_matches')
    .select('id, post_id')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error || !data) return null
  const rows = data as { id: string; post_id: string }[]
  const hits = rows.filter((r) => r.id.toLowerCase().startsWith(p))
  return hits.length === 1 ? hits[0] : null
}

/**
 * Try to handle an officer "/ok <id>" or "/no <id>". Returns the reply string if it was an officer
 * command from the officer, or null (fall through to the orchestrator) otherwise.
 */
export async function tryOfficerCommand(userId: string, text: string): Promise<string | null> {
  const match = OFFICER_RX.exec(text.trim())
  if (!match) return null

  // Officer gate. Non-officers (or when unconfigured) fall through silently.
  const officer = config.concierge.officerImessage
  if (!officer || userId !== normalizeHandle(officer)) return null

  const verb = match[1].toLowerCase() // 'ok' | 'no'
  const prefix = match[2]
  const found = await resolvePendingByPrefix(prefix)
  if (!found) return `没找到待处理的匹配 ${prefix} 🤔 (可能已经处理过了)`

  const deps = await buildProposalDeps(found.post_id)
  if (verb === 'ok') {
    const r = await sendApprovedMatch(found.id, userId, deps)
    return r.outcome === 'sent'
      ? '发了 ✅'
      : r.outcome === 'noop'
        ? '这个已经处理过了'
        : `没发出去 — 对方可能静音了/局满了/到点了 (${'reason' in r ? r.reason : '?'})`
  }
  const r = await rejectMatch(found.id, userId, deps)
  return r.outcome === 'rejected' ? '拒了 🫡' : '这个已经处理过了'
}
