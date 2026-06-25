// Supabase-backed OutgoingSchedulerDB for the restart-durable outgoing-bubble
// queue (Pacing & Delivery v1, Task 3).
//
// Backs src/adapters/outgoing-scheduler.ts against the `public.outgoing_bubbles`
// table. The table has deny-all RLS; george reaches it ONLY through the
// SERVICE-ROLE supabase client (the `supabase` export from ./client.js — the
// same one every other src/db file uses). Keeping the service-role client strictly
// inside src/db is the guardrail: callers above this layer never see it.
//
// Seam contract uses epoch-ms numbers; the table columns are timestamptz. This
// file is the ONLY place that converts between the two (ms → ISO on write,
// ISO → ms on read). A null sent_at means the bubble is still pending.
//
// Schema (bia-admin migration, not yet applied here):
//   outgoing_bubbles(id uuid pk, handle text, content text, seq int,
//                    send_at timestamptz, sent_at timestamptz null,
//                    created_at timestamptz default now())
//
// Header last reviewed: 2026-06-24

import { supabase } from './client.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  OutgoingBubbleRow,
  OutgoingSchedulerDB,
} from '../adapters/outgoing-scheduler.js'

// Default selectDue page size. The drainer ticks ~1/s, so a burst's tail is a
// handful of rows; 50 is comfortable headroom without unbounded reads.
const DEFAULT_DUE_LIMIT = 50

// Raw row shape as it comes back from PostgREST (timestamptz are ISO strings).
interface OutgoingBubbleDbRow {
  id: string
  handle: string
  content: string
  seq: number
  send_at: string
  sent_at: string | null
}

function toSeamRow(r: OutgoingBubbleDbRow): OutgoingBubbleRow {
  return {
    id: r.id,
    handle: r.handle,
    content: r.content,
    seq: r.seq,
    sendAt: Date.parse(r.send_at),
    sentAt: r.sent_at === null ? null : Date.parse(r.sent_at),
  }
}

/**
 * Build the Supabase-backed OutgoingSchedulerDB. `supabase` (service-role) is the
 * default client; an injectable param keeps it testable in the same style as the
 * other src/db modules, but production always uses the default service-role client.
 */
export function createSupabaseOutgoingSchedulerDB(
  sb: SupabaseClient = supabase,
): OutgoingSchedulerDB {
  return {
    async insertBubbles(rows) {
      if (rows.length === 0) return
      const payload = rows.map((r) => ({
        handle: r.handle,
        content: r.content,
        seq: r.seq,
        send_at: new Date(r.sendAt).toISOString(),
      }))
      const { error } = await sb.from('outgoing_bubbles').insert(payload)
      if (error) throw new Error(`insertBubbles failed: ${error.message}`)
    },

    async selectDue(nowMs, limit) {
      const isoNow = new Date(nowMs).toISOString()
      const { data, error } = await sb
        .from('outgoing_bubbles')
        .select('id, handle, content, seq, send_at, sent_at')
        .is('sent_at', null)
        .lte('send_at', isoNow)
        .order('send_at')
        .limit(limit ?? DEFAULT_DUE_LIMIT)
      if (error) throw new Error(`selectDue failed: ${error.message}`)
      return ((data ?? []) as OutgoingBubbleDbRow[]).map(toSeamRow)
    },

    async markSent(id, sentAtMs) {
      const { error } = await sb
        .from('outgoing_bubbles')
        .update({ sent_at: new Date(sentAtMs).toISOString() })
        .eq('id', id)
      if (error) throw new Error(`markSent failed: ${error.message}`)
    },

    async cancelPending(handle) {
      // Delete still-pending rows for the handle; return how many were removed.
      // `count: 'exact'` on a delete reports the deleted-row count.
      const { error, count } = await sb
        .from('outgoing_bubbles')
        .delete({ count: 'exact' })
        .eq('handle', handle)
        .is('sent_at', null)
      if (error) throw new Error(`cancelPending failed: ${error.message}`)
      return count ?? 0
    },
  }
}
