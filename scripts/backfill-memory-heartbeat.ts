// scripts/backfill-memory-heartbeat.ts
// One-time backfill: create empty profile + default heartbeat config for every existing student.
// Run via: pnpm tsx scripts/backfill-memory-heartbeat.ts

import { createServiceRoleClient } from '../src/memory/supabase-client.js';

async function main() {
  const supabase = createServiceRoleClient();
  console.log('[backfill] querying existing students...');
  const { data: students, error } = await supabase.from('students').select('user_id');
  if (error) throw error;
  if (!students || students.length === 0) {
    console.log('[backfill] no students found, nothing to do');
    return;
  }
  console.log(`[backfill] ${students.length} students to backfill`);

  const profileRows = students.map((s) => ({
    user_id: s.user_id,
    identity: '',
    academic: '',
    interests: '',
    relationships: '',
    state: 'backfilled: true, onboarded_at: pre-slice-beta',
    george_notes: '',
  }));
  const configRows = students.map((s) => ({
    user_id: s.user_id,
    cadence: '12 hours',
    active_hours_start: '09:00:00',
    active_hours_end: '22:00:00',
    timezone: 'America/Los_Angeles',
    paused: false,
    consent_proactive_messages: false,
    consent_anomaly_checkin: false,
  }));
  const instructionsRows = students.map((s) => ({
    user_id: s.user_id,
    content:
      '# Backfilled user\n\nNo onboarding flow ran. Defaults applied. Be conservative with proactive nudges (consent_proactive_messages=false).',
  }));

  console.log('[backfill] inserting profile rows (upsert, skip-existing)...');
  const { error: pErr } = await supabase
    .from('user_profiles')
    .upsert(profileRows, { onConflict: 'user_id', ignoreDuplicates: true });
  if (pErr) throw pErr;

  console.log('[backfill] inserting config rows...');
  const { error: cErr } = await supabase
    .from('user_heartbeat_config')
    .upsert(configRows, { onConflict: 'user_id', ignoreDuplicates: true });
  if (cErr) throw cErr;

  console.log('[backfill] inserting instruction rows...');
  const { error: iErr } = await supabase
    .from('user_heartbeat_instructions')
    .upsert(instructionsRows, { onConflict: 'user_id', ignoreDuplicates: true });
  if (iErr) throw iErr;

  console.log('[backfill] complete.');
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
