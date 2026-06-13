// src/services/squad-ping-engine.ts
// Ping fan-out for a freshly approved 局 (spec §5.2 step 4, §8).
// Consent (pings_enabled) is already enforced INSIDE match_users_for_post at the
// SQL layer (defense in depth); this engine enforces the runtime suppressions —
// weekly cap, quiet hours, category scoping, channel — and records EVERY outcome
// in squad_pings. Nothing is ever silently dropped (eng E3 / invariant #3).
// Delivery is injected (Task-1 strategy: Spectrum direct via sendProactive).

export interface MatchCandidate {
  student_id: string; rrf_score: number; semantic_sim: number | null;
  tag_overlap: number; matched_tags: string[]; best_facet: string | null;
}
export interface MatchPrefs {
  student_id: string; pings_enabled: boolean; weekly_ping_cap: number;
  quiet_start_hour: number; quiet_end_hour: number;
  allowed_categories: string[] | null; channel: string;
}
export interface PingRow {
  post_id: string; recipient_student_id: string; score: number; channel: string;
  status: 'sent' | 'suppressed_no_channel' | 'suppressed_cap' | 'suppressed_quiet_hours' | 'suppressed_muted';
  sent_at: string | null;
}
export interface PingDeps {
  matchUsers: (postId: string) => Promise<MatchCandidate[]>;
  loadPrefs: (studentId: string) => Promise<MatchPrefs | null>;
  countSentThisWeek: (studentId: string) => Promise<number>;
  handleFor: (studentId: string) => Promise<string | null>;
  recordPing: (row: PingRow) => Promise<void>;
  deliver: (handle: string, bubbles: string[]) => Promise<void>;
  composePing: (candidate: MatchCandidate, postId: string) => string[];
  nowHourLA: () => number;
  maxPings: number;
  postCategory?: string;
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export async function runPingFanout(
  postId: string,
  deps: PingDeps,
): Promise<{ sent: number; suppressed: number }> {
  const candidates = (await deps.matchUsers(postId))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, deps.maxPings);

  let sent = 0, suppressed = 0;
  for (const c of candidates) {
    const prefs = await deps.loadPrefs(c.student_id);
    const base = { post_id: postId, recipient_student_id: c.student_id, score: c.rrf_score };

    const record = async (status: PingRow['status'], channel = prefs?.channel ?? 'imessage') => {
      await deps.recordPing({ ...base, channel, status, sent_at: status === 'sent' ? new Date().toISOString() : null });
      status === 'sent' ? sent++ : suppressed++;
    };

    if (!prefs || !prefs.pings_enabled) { await record('suppressed_muted'); continue; }
    if (prefs.allowed_categories && deps.postCategory &&
        !prefs.allowed_categories.includes(deps.postCategory)) { await record('suppressed_muted'); continue; }
    if ((await deps.countSentThisWeek(c.student_id)) >= prefs.weekly_ping_cap) { await record('suppressed_cap'); continue; }
    if (inQuietHours(deps.nowHourLA(), prefs.quiet_start_hour, prefs.quiet_end_hour)) { await record('suppressed_quiet_hours'); continue; }

    const handle = await deps.handleFor(c.student_id);
    if (!handle) { await record('suppressed_no_channel'); continue; }

    // Delivery and recording are separate concerns. A successfully delivered
    // ping must NEVER be relabeled 'suppressed_no_channel' just because writing
    // its row failed, and a recording error must NOT abort the whole fan-out.
    let delivered = false;
    try {
      await deps.deliver(handle, deps.composePing(c, postId));
      delivered = true;
    } catch {
      delivered = false;
    }
    if (!delivered) {
      try { await record('suppressed_no_channel'); } catch { suppressed++; }
      continue;
    }
    try {
      await record('sent');
    } catch {
      // Delivered, but the row write failed: count the delivery, never relabel it.
      sent++;
    }
  }
  return { sent, suppressed };
}
