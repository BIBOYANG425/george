// src/services/funnel-log.ts
// Concierge funnel-stage logger: ONE fail-soft, idempotent insert per stage so funnel leaks are
// visible per student without ever blocking the funnel. Mirrors the fail-soft insert pattern of
// writeLog (src/index.ts) — a logging failure is swallowed (console.error), never thrown.
//
// Idempotency: funnel_events has a UNIQUE (student_id, stage, ref_id) NULLS NOT DISTINCT index, so
// 'onboarded' (ref_id NULL) fires once per student across BOTH completion paths (george
// update-profile.ts + the bia-roommate web form) and any retries. We upsert with ignoreDuplicates.
// Repeatable stages (match_proposed / intro_sent) carry a distinct ref_id (the post), so they are
// recorded once per (student, stage, post) — exactly the funnel semantics we want.

import { supabase } from '../db/client.js'

export type FunnelStage =
  | 'onboarded'
  | 'surfaced'
  | 'opted_in'
  | 'match_proposed'
  | 'match_approved'
  | 'intro_sent'
  | 'showed_up'

export async function logFunnelEvent(
  studentId: string,
  stage: FunnelStage,
  opts: { refId?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const { error } = await supabase.from('funnel_events').upsert(
      {
        student_id: studentId,
        stage,
        ref_id: opts.refId ?? null,
        meta: opts.meta ?? {},
      },
      { onConflict: 'student_id,stage,ref_id', ignoreDuplicates: true },
    )
    // Fail-soft: a funnel-log miss must never break the concierge flow it is observing.
    if (error) console.error('funnel_events log failed', { stage, error: error.message })
  } catch (e) {
    console.error('funnel_events log threw', { stage, err: (e as Error).message })
  }
}
