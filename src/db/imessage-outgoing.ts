// Outgoing-iMessage queue used by Path B (iPhone Shortcuts mode).
//
// Container writes a row after processMessage produces a reply. The dedicated
// iPhone polls `pending` rows every minute via a Personal Automation, sends
// each one via the Messages.app Shortcut action, then POSTs an ack that
// flips status to 'sent' (or 'failed' with an error string).
//
// In Path A (Mac mini bridge mode) this table is unused — replies travel
// back to the bridge inline over the /chat HTTP response.
//
// ATTACHMENTS — added 2026-06-08 for Slice B onboarding handshake.
// Each row may now carry `text`, `images` (PNG/JPG paths), and/or `files`
// (other attachments like .vcf contact cards). Migration
// 20260608000001_imessage_outgoing_attachments adds those columns and
// drops the NOT NULL on text. At least one of the three must be non-empty
// per row (DB check constraint imessage_outgoing_has_content).
//
// IPHONE SHORTCUT — the deployed Shortcut that polls /imessage/outgoing
// needs a parallel update: read `images` and `files` from each row and
// include them as Messages.app attachments alongside the text body when
// sending. The Shortcut update is a Bobby ops task; the codebase here
// only writes the rows.
//
// Header last reviewed: 2026-06-08

import { supabase } from './client.js'

export interface OutgoingRow {
  id: string
  recipient: string
  text: string | null
  images: string[]
  files: string[]
  queued_at: string
}

export interface OutgoingPayload {
  text?: string
  images?: string[]
  files?: string[]
}

export async function enqueueOutgoing(
  recipient: string,
  payload: string | OutgoingPayload,
): Promise<void> {
  const body: OutgoingPayload =
    typeof payload === 'string' ? { text: payload } : payload
  const row: Record<string, unknown> = { recipient }
  if (body.text !== undefined) row.text = body.text
  if (body.images && body.images.length > 0) row.images = body.images
  if (body.files && body.files.length > 0) row.files = body.files
  const { error } = await supabase.from('imessage_outgoing').insert(row)
  if (error) throw new Error(`enqueueOutgoing failed: ${error.message}`)
}

// KNOWN GAP — race vulnerability between consecutive polls.
//
// fetchPending currently SELECTs status='pending'. If the iPhone's polling
// Shortcut runs twice in quick succession (iOS Personal Automation can fire
// before the previous run finishes), both polls fetch the same rows and the
// user gets the same iMessage twice. Same race exists if Cloudflare retries
// the request on a transient 5xx the iPhone never saw.
//
// Production-grade fix: atomic claim via Postgres RPC that does
//   UPDATE imessage_outgoing SET status='sending', claimed_at=now()
//   WHERE id IN (SELECT id FROM imessage_outgoing
//                WHERE status='pending'
//                ORDER BY queued_at LIMIT $1 FOR UPDATE SKIP LOCKED)
//   RETURNING *
// plus a 5-minute stale-claim recovery so dropped sends get re-tried.
//
// Deferred because: single-iPhone Path B polling makes the race rare in
// practice, the user-facing impact is "occasional duplicate iMessage"
// (annoying, not catastrophic), and the fix needs a schema migration to
// add a 'sending' state + claimed_at column. Revisit before adding a
// second poller or when daily volume exceeds a few hundred messages.
export async function fetchPending(afterISO?: string, limit = 10): Promise<OutgoingRow[]> {
  let q = supabase
    .from('imessage_outgoing')
    .select('id, recipient, text, images, files, queued_at')
    .eq('status', 'pending')
    .order('queued_at', { ascending: true })
    .limit(limit)
  if (afterISO) q = q.gt('queued_at', afterISO)
  const { data, error } = await q
  if (error) throw new Error(`fetchPending failed: ${error.message}`)
  return (data ?? []) as OutgoingRow[]
}

export async function ackOutgoing(
  id: string,
  status: 'sent' | 'failed',
  errorMessage?: string,
): Promise<void> {
  const patch: Record<string, unknown> = { status, error: errorMessage ?? null }
  if (status === 'sent') patch.sent_at = new Date().toISOString()
  const { error } = await supabase.from('imessage_outgoing').update(patch).eq('id', id)
  if (error) throw new Error(`ackOutgoing failed: ${error.message}`)
}
