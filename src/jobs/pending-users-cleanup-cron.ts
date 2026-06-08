// Daily cron that purges pending_users rows older than 14 days. Pending rows
// are created when a freshman mints an onboarding code on the web; if they
// never send the -START iMessage handshake, the row sits in 'pending' status
// forever. Slice B contract: garbage-collect after 14 days so the table stays
// small and a recycled code can be re-issued.
//
// Header last reviewed: 2026-06-08

import cron from 'node-cron';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanupOld } from '../onboarding/pending-users.js';

export function startPendingUsersCleanupCron(
  supabase: SupabaseClient,
): ReturnType<typeof cron.schedule> {
  return cron.schedule(
    '0 3 * * *',
    async () => {
      try {
        const removed = await cleanupOld(supabase, 14);
        console.log(`[pending-cleanup] removed ${removed} pending rows >14 days old`);
      } catch (err) {
        console.error('[pending-cleanup] failed:', (err as Error).message);
      }
    },
    { timezone: 'America/Los_Angeles' },
  );
}
