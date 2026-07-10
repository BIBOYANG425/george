// src/jobs/heartbeat-scheduler.ts
import cron from 'node-cron';
import { tzHourMinute } from '../agent/la-time.js';

export interface ConfigRow {
  user_id: string;
  cadence: string;
  last_heartbeat_at: string | null;
  active_hours_start: string;
  active_hours_end: string;
  timezone: string;
  paused: boolean;
  pause_until: string | null;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;

// Cap simultaneous heartbeat runs. A tick can find many due users; firing them
// all at once fans out an unbounded number of concurrent DeepSeek calls (each a
// long LLM round-trip). A small pool keeps the fan-out bounded without a new dep.
const HEARTBEAT_MAX_CONCURRENCY = 4;

const CADENCE_MS: Readonly<Record<string, number | null>> = {
  '12 hours': 12 * 60 * 60 * 1000,
  '24 hours': 24 * 60 * 60 * 1000,
  '7 days': 7 * 24 * 60 * 60 * 1000,
  off: null,
};

export function parseCadenceMs(cadence: string): number | null {
  return Object.prototype.hasOwnProperty.call(CADENCE_MS, cadence)
    ? CADENCE_MS[cadence]!
    : null;
}

// Per-user timezone (not always LA), so pass the row's timezone through to the
// shared formatter rather than defaulting to LA.
function currentLocalTime(now: Date, timezone: string): { hours: number; minutes: number } {
  return tzHourMinute(now, timezone);
}

// True when the user's local wall-clock is inside their active-hours window.
// Handles BOTH orientations:
//   • same-day window (start < end, e.g. 09:00–22:00): [start, end)
//   • overnight window (start > end, e.g. 22:00–06:00): the window wraps past
//     midnight, so "inside" is [start, 24:00) ∪ [00:00, end) — i.e. at-or-after
//     start OR before end. Without this branch an overnight window was never
//     satisfiable (start >= end could never both hold), so those users never
//     fired. start == end is treated as an empty window (never active), matching
//     the pre-existing `>= start && < end` behavior for a degenerate config.
// Exported for direct boundary/overnight unit tests.
export function isWithinActiveHours(now: Date, row: ConfigRow): boolean {
  const local = currentLocalTime(now, row.timezone);
  const [startH, startM] = row.active_hours_start.split(':').map(Number);
  const [endH, endM] = row.active_hours_end.split(':').map(Number);
  const localMin = local.hours * 60 + local.minutes;
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  if (startMin <= endMin) {
    // Same-day (or degenerate empty) window.
    return localMin >= startMin && localMin < endMin;
  }
  // Overnight wrap: active at-or-after start (late) OR before end (early morning).
  return localMin >= startMin || localMin < endMin;
}

export function selectDueUsers(rows: ConfigRow[], now: Date): ConfigRow[] {
  return rows.filter((row) => {
    if (row.paused && (!row.pause_until || new Date(row.pause_until) > now)) {
      return false;
    }
    if (!isWithinActiveHours(now, row)) {
      return false;
    }
    const cadenceMs = parseCadenceMs(row.cadence);
    if (cadenceMs === null) return false;
    if (row.last_heartbeat_at) {
      const last = new Date(row.last_heartbeat_at);
      if (now.getTime() - last.getTime() < cadenceMs) {
        return false;
      }
    }
    return true;
  });
}

// Hand-rolled bounded-concurrency map (no p-limit dependency). Runs `worker`
// over `items` with at most `limit` in flight at once via a fixed pool of runner
// loops pulling from a shared cursor. `worker` must not reject (callers wrap their
// own error handling); a rejection would surface through Promise.all. Exported for
// a focused unit test of the concurrency bound + full coverage.
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const max = Math.max(1, Math.floor(limit));
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
    }
  };
  const pool = Array.from({ length: Math.min(max, items.length) }, () => runner());
  await Promise.all(pool);
}

export async function dispatchHeartbeats(
  userIds: string[],
  run: (userId: string, signal: AbortSignal) => Promise<void>
): Promise<void> {
  // Bounded fan-out: at most HEARTBEAT_MAX_CONCURRENCY runs in flight. Each run
  // races a per-user timeout; the timeout aborts an AbortController threaded into
  // the run (→ callLLM → the DeepSeek fetch), so a hung upstream call is actually
  // cancelled rather than left dangling. Per-user errors are caught so one failure
  // never stops the pool.
  await runWithConcurrency(userIds, HEARTBEAT_MAX_CONCURRENCY, async (uid) => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run(uid, ac.signal),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`Heartbeat timeout for ${uid}`));
          }, HEARTBEAT_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.error(`[heartbeat] ${uid} failed:`, (err as Error).message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

export interface SchedulerDeps {
  loadAllConfigs: () => Promise<ConfigRow[]>;
  // signal is threaded from the per-run timeout so the underlying LLM fetch can be
  // aborted; optional at the call site so callers/tests that ignore it still fit.
  runHeartbeat: (userId: string, signal?: AbortSignal) => Promise<void>;
}

export function startHeartbeatScheduler(deps: SchedulerDeps): cron.ScheduledTask {
  return cron.schedule('*/10 * * * *', async () => {
    const startTime = Date.now();
    try {
      const rows = await deps.loadAllConfigs();
      const due = selectDueUsers(rows, new Date());
      console.log(`[heartbeat] tick: ${rows.length} users total, ${due.length} due`);
      if (due.length > 0) {
        await dispatchHeartbeats(due.map((d) => d.user_id), deps.runHeartbeat);
      }
      console.log(`[heartbeat] tick complete in ${Date.now() - startTime}ms`);
    } catch (err) {
      console.error('[heartbeat] scheduler tick failed:', err);
    }
  });
}

// Minimal shape of the Spectrum client's proactive send used by the router below.
export interface ProactiveSpectrumClient {
  sendProactive(handle: string, bubbles: string[]): Promise<void>;
}

export interface ProactiveSenderDeps {
  // Live Spectrum client when connected, else null (legacy transport, or Spectrum
// reconnecting). Read per-send so a reconnect is picked up.
  getSpectrumClient: () => ProactiveSpectrumClient | null;
  // Durable legacy queue (imessage_outgoing) fallback.
  enqueueLegacy: (to: string, text: string) => Promise<void>;
  transport?: 'legacy' | 'spectrum';
}

// Build the heartbeat proactive-send function. Under the Spectrum transport the
// legacy imessage_outgoing queue has NO drainer (no iPhone Shortcut polling), so a
// proactive enqueued there would rot forever; route it through the LIVE Spectrum
// client (sendProactive opens a 1:1 space) when connected. Legacy transport retains
// its durable queue. Spectrum reconnects fail retryably because that legacy queue has
// no drainer in Spectrum mode and therefore cannot truthfully report delivery.
export function makeProactiveSender(
  deps: ProactiveSenderDeps,
): (msg: { to: string; text: string }) => Promise<void> {
  return async (msg) => {
    const client = deps.getSpectrumClient();
    if (client) {
      await client.sendProactive(msg.to, [msg.text]);
      return;
    }
    if (deps.transport === 'spectrum') {
      throw new Error('Spectrum transport unavailable; proactive delivery is retryable');
    }
    await deps.enqueueLegacy(msg.to, msg.text);
  };
}
