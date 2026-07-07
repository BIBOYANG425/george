// src/jobs/guarded-cron.ts
// The overlap-guarded, timed, tagged cron tick shared by the two squad crons
// (squad-coordinator + rereach-eval). Each had an identical inline block: a `running`
// flag so a slow tick never stacks on the next, per-tick timing, and [name]-tagged
// start-skip / complete / fail logging. Extracted so both share one implementation.
//
// NOTE: the schedule is a node-cron expression (e.g. '*/15 * * * *'), NOT a
// millisecond interval — the squad crons fire on wall-clock cron boundaries and that
// timing is preserved by passing the expression straight to node-cron.
//
// Header last reviewed: 2026-07-07
import cron from 'node-cron';

// Build the guarded tick handler as a standalone async fn (own `running` flag) so it
// unit-tests without scheduling anything. Logging + overlap-guard behavior are
// byte-for-byte the squad crons' previous inline behavior.
export function makeGuardedTick(name: string, fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      console.log(`[${name}] previous tick still running, skipping`);
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      await fn();
      console.log(`[${name}] tick complete in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`[${name}] tick failed:`, err);
    } finally {
      running = false;
    }
  };
}

// Schedule the guarded tick on a node-cron expression.
export function scheduleGuardedCron(
  name: string,
  cronExpr: string,
  fn: () => Promise<void>,
): cron.ScheduledTask {
  return cron.schedule(cronExpr, makeGuardedTick(name, fn));
}
