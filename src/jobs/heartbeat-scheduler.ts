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

function parseCadenceHours(cadence: string): number {
  const m = cadence.match(/(\d+)\s*hours?/);
  return m ? parseInt(m[1], 10) : 12;
}

// Per-user timezone (not always LA), so pass the row's timezone through to the
// shared formatter rather than defaulting to LA.
function currentLocalTime(now: Date, timezone: string): { hours: number; minutes: number } {
  return tzHourMinute(now, timezone);
}

function isWithinActiveHours(now: Date, row: ConfigRow): boolean {
  const local = currentLocalTime(now, row.timezone);
  const [startH, startM] = row.active_hours_start.split(':').map(Number);
  const [endH, endM] = row.active_hours_end.split(':').map(Number);
  const localMin = local.hours * 60 + local.minutes;
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  return localMin >= startMin && localMin < endMin;
}

export function selectDueUsers(rows: ConfigRow[], now: Date): ConfigRow[] {
  return rows.filter((row) => {
    if (row.paused && (!row.pause_until || new Date(row.pause_until) > now)) {
      return false;
    }
    if (!isWithinActiveHours(now, row)) {
      return false;
    }
    if (row.last_heartbeat_at) {
      const last = new Date(row.last_heartbeat_at);
      const hours = parseCadenceHours(row.cadence);
      if (now.getTime() - last.getTime() < hours * 3600 * 1000) {
        return false;
      }
    }
    return true;
  });
}

export async function dispatchHeartbeats(
  userIds: string[],
  run: (userId: string) => Promise<void>
): Promise<void> {
  const tasks = userIds.map((uid) =>
    Promise.race([
      run(uid),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`Heartbeat timeout for ${uid}`)), HEARTBEAT_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      console.error(`[heartbeat] ${uid} failed:`, err.message);
    })
  );
  await Promise.allSettled(tasks);
}

export interface SchedulerDeps {
  loadAllConfigs: () => Promise<ConfigRow[]>;
  runHeartbeat: (userId: string) => Promise<void>;
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
