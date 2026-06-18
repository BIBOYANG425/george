// scripts/dashboard-server.ts
//
// Standalone admin dashboard server. Boots ONLY the admin router (reads from
// Supabase) — no orchestrator, no crons, no iMessage/Spectrum adapters — so it
// starts in ~1s and is safe to run while the real george server is or isn't up.
//
// Usage:
//   npm run dashboard                 # http://localhost:3009/admin/dashboard
//   DASHBOARD_PORT=4000 npm run dashboard
//
// Open:  http://localhost:3009/admin/dashboard?token=$ADMIN_TOKEN
// (the token is stored in the browser after the first load; or paste it on the
//  login screen). Reads the same .env the server uses (SUPABASE_*, ADMIN_TOKEN).

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { createAdminDashboardRouter } from '../src/admin/router.js';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3009', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('✖ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env');
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.warn('⚠ ADMIN_TOKEN not set — the dashboard API will return 503. Set it in .env.');
}

// Resilience: a stray async rejection (e.g. a Supabase request settling after a
// response) must NOT take the whole dashboard process down. Log and keep serving.
process.on('uncaughtException', (err) => {
  console.error('[dashboard] uncaughtException:', (err as Error).message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[dashboard] unhandledRejection:', String(reason));
});

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const app = express();
app.use(cors());
app.use(express.json());
app.use(createAdminDashboardRouter(sb, ADMIN_TOKEN));

app.get('/', (_req, res) => res.redirect('/admin/dashboard'));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'george-admin-dashboard' }));

app.listen(PORT, () => {
  console.log('\n  George Admin Dashboard (standalone)');
  console.log('  ───────────────────────────────────');
  console.log(`  ▸ http://localhost:${PORT}/admin/dashboard`);
  if (ADMIN_TOKEN) {
    console.log(`  ▸ direct (token in URL): http://localhost:${PORT}/admin/dashboard?token=${ADMIN_TOKEN}`);
  }
  console.log(`  reading: ${SUPABASE_URL.replace(/https?:\/\//, '')}\n`);
});
