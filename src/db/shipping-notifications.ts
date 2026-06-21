import { supabase } from './client.js'

// Staleness cutoff: a parcel status update from more than 24h ago is no longer
// timely, and a fresh boot after downtime (or after the notifier was disabled)
// must not blast a multi-day backlog at real students.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

// Drains the shipping_notifications queue (producer = parcels AFTER-UPDATE
// trigger, migration 20260606_parcel_notification_enqueue.sql). Joins students
// for the delivery platform id. Bounded LIMIT so one cron tick can't run away.
// Only rows scheduled within the last 24h are eligible — older pending rows
// are triaged to 'skipped' by markStaleNotificationsSkipped() at job start.
export async function getPendingShippingNotifications() {
  const now = Date.now()
  const { data, error } = await supabase
    .from('shipping_notifications')
    .select(
      'id, kind, payload, created_at, students(id, wechat_open_id, imessage_id, name, shipping_notif_opt_out)',
    )
    .eq('status', 'pending')
    .lte('scheduled_for', new Date(now).toISOString())
    .gte('scheduled_for', new Date(now - STALE_AFTER_MS).toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(100)
  // Surface read errors (missing column/table/RLS/relationship) instead of
  // silently sending nothing forever (Codex #5).
  if (error) console.error('[getPendingShippingNotifications]', error.message)
  return data || []
}

// Triage: mark every still-pending row scheduled more than 24h ago as
// 'skipped' ('skipped' is in the status CHECK — 20260419_shipping.sql) so the
// backlog is visibly resolved in the table instead of silently filtered
// forever by the 24h window above. Returns the number of rows skipped.
export async function markStaleNotificationsSkipped(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString()
  const { data, error } = await supabase
    .from('shipping_notifications')
    .update({ status: 'skipped', error: 'stale_pending_over_24h' })
    .eq('status', 'pending')
    .lt('scheduled_for', cutoff)
    .select('id')
  if (error) throw new Error(`markStaleNotificationsSkipped failed: ${error.message}`)
  return data?.length ?? 0
}

export async function markShippingNotificationSent(id: string) {
  const { error } = await supabase
    .from('shipping_notifications')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id)
  // If this write fails the row stays 'pending' and WILL be resent next tick —
  // surface it loudly so a stuck row doesn't silently spam a student (Codex #2).
  if (error) {
    console.error('[markShippingNotificationSent] FAILED — resend risk', id, error.message)
  }
}

// Terminal non-delivery we never want to retry (no copy for the kind, or the
// student has no reachable platform id).
export async function markShippingNotificationSkipped(id: string, reason: string) {
  const { error } = await supabase
    .from('shipping_notifications')
    .update({ status: 'skipped', error: reason })
    .eq('id', id)
  if (error) {
    console.error('[markShippingNotificationSkipped] FAILED', id, error.message)
  }
}

// Delivery attempt failed. Terminal with this schema (no retry_count column);
// a future retry/backoff would add one. Acts as the dead-letter state.
export async function markShippingNotificationFailed(id: string, error: string) {
  const { error: dbErr } = await supabase
    .from('shipping_notifications')
    .update({ status: 'failed', error })
    .eq('id', id)
  if (dbErr) {
    console.error('[markShippingNotificationFailed] FAILED', id, dbErr.message)
  }
}
