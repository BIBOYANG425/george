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
// Open:  http://localhost:3009/admin/dashboard
// (paste the ADMIN_TOKEN on the login screen; it is stored in the browser after
//  the first load). Reads the same .env the server uses (SUPABASE_*, ADMIN_TOKEN).
//
// CORS is OFF by default: the dashboard SPA is served same-origin, so no CORS
// header is needed. Set ADMIN_DASHBOARD_ORIGIN to a specific origin to allow a
// cross-origin dashboard front-end; absent → no cors middleware is mounted.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { createAdminDashboardRouter } from '../src/admin/router.js';

// Cloud platforms (Railway, Cloudflare Container, Fly) inject PORT; honor it
// first, then DASHBOARD_PORT for local runs, else default 3009.
const PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3009', 10);
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
// CORS is OFF unless ADMIN_DASHBOARD_ORIGIN names a specific allowed origin. The
// dashboard SPA is served same-origin, so the old wildcard cors() default let any
// site call the token-gated API from a signed-in user's browser. Absent → no cors
// middleware at all (same-origin only).
const DASHBOARD_ORIGIN = process.env.ADMIN_DASHBOARD_ORIGIN;
if (DASHBOARD_ORIGIN) {
  app.use(cors({ origin: DASHBOARD_ORIGIN, credentials: false }));
}
app.use(express.json());
app.use(createAdminDashboardRouter(sb, ADMIN_TOKEN));

app.get('/', (_req, res) => res.redirect('/admin/dashboard'));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'george-admin-dashboard' }));

app.listen(PORT, () => {
  console.log('\n  George Admin Dashboard (standalone)');
  console.log('  ───────────────────────────────────');
  console.log(`  ▸ http://localhost:${PORT}/admin/dashboard`);
  console.log(`  reading: ${SUPABASE_URL.replace(/https?:\/\//, '')}\n`);
});
