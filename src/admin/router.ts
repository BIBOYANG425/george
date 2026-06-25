// src/admin/router.ts
//
// Admin dashboard router. Serves the single-page dashboard at /admin/dashboard
// and a JSON analytics API at /admin/api/*. Every API route is gated by the
// admin token (Bearer header, x-admin-token header, OR ?token= query — the
// query form exists so the static page and a screenshot tool can load it with
// one URL during local viewing).
//
// Mount it in two ways:
//   - inside the full george server (src/index.ts) — shares the app
//   - standalone (scripts/dashboard-server.ts) — boots only this router, so you
//     can view the dashboard without starting the agent stack / crons / adapters.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getOverview,
  getTimeseries,
  getLiveFeed,
  getDistributions,
  getUsers,
  getUserDetail,
  getSystemHealth,
  setHeartbeatPaused,
  getFlaggedTurns,
  getFabricationSuspects,
} from './analytics.js';
import { renderDashboardHtml } from './dashboard-html.js';
import { getUserControls, setUserControls, getUsageSnapshot, getModelChoices } from './user-controls.js';
import { logAdminAction, adminActor, flagMessage } from './actions.js';

export function createAdminDashboardRouter(sb: SupabaseClient, adminToken: string): express.Router {
  const router = express.Router();

  // The dashboard page itself is harmless static HTML (it carries no data); the
  // data endpoints are what's gated. Serve it openly so the browser can load it,
  // then it prompts for / stores the token and calls the gated API.
  router.get('/admin/dashboard', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboardHtml());
  });

  // ── auth gate for the API ──
  const auth: express.RequestHandler = (req, res, next) => {
    if (!adminToken) {
      res.status(503).json({ error: 'ADMIN_TOKEN not configured on the server' });
      return;
    }
    const bearer = req.headers.authorization?.replace('Bearer ', '');
    const header = req.headers['x-admin-token'];
    const q = typeof req.query.token === 'string' ? req.query.token : undefined;
    const token = bearer || (typeof header === 'string' ? header : undefined) || q || '';
    if (!safeEqual(token, adminToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  const api = express.Router();
  api.use(auth);

  const wrap =
    (fn: (req: express.Request) => Promise<unknown>): express.RequestHandler =>
    async (req, res) => {
      try {
        res.json(await fn(req));
      } catch (err) {
        console.error('[admin] api error:', (err as Error).message);
        res.status(500).json({ error: 'internal_error', detail: (err as Error).message });
      }
    };

  api.get('/overview', wrap(() => getOverview(sb)));
  api.get('/timeseries', wrap((req) => getTimeseries(sb, clampInt(req.query.days, 14, 1, 90))));
  api.get('/live', wrap((req) =>
    getLiveFeed(sb, { limit: clampInt(req.query.limit, 60, 1, 200), onlyToday: req.query.today === '1' }),
  ));
  api.get('/distributions', wrap(() => getDistributions(sb)));
  api.get('/users', wrap((req) => getUsers(sb, clampInt(req.query.limit, 100, 1, 500))));
  api.get('/user/:id', wrap((req) => getUserDetail(sb, String(req.params.id))));
  api.get('/health', wrap(() => getSystemHealth(sb)));

  // AI-quality review: flagged turns + fabrication suspects (both read-only,
  // fail-soft if message_flags isn't migrated). PR-3 prepends the crisis queue here.
  api.get('/review', wrap(async () => {
    const [flagged, fab] = await Promise.all([getFlaggedTurns(sb, 100), getFabricationSuspects(sb, {})]);
    return { flagged, fabrication: fab };
  }));

  // Flag a George turn as a bad reply. Snapshot is built server-side from the
  // messages row; actor is the Cf-Access admin (or the shared token locally).
  api.post('/message/:id/flag', wrap(async (req) => {
    const id = String(req.params.id);
    const b = (req.body ?? {}) as { kind?: string; reason?: string };
    const kind = typeof b.kind === 'string' && b.kind.trim() ? b.kind.trim() : 'bad_turn';
    const reason = typeof b.reason === 'string' ? b.reason.trim() : undefined;
    const r = await flagMessage(sb, { messageId: id, kind, reason, actor: adminActor(req) });
    // A failed flag (table not migrated, FK violation, DB error) must surface as a
    // non-2xx so the client throws — otherwise wrap() 200s the {ok:false} body and
    // the UI shows a false "✓ 已标记" while nothing persisted.
    if (!r.ok) throw new Error(r.error || 'flag failed');
    return r;
  }));

  api.post('/user/:id/pause', wrap(async (req) => {
    const id = String(req.params.id);
    const r = await setHeartbeatPaused(sb, id, true);
    await logAdminAction(sb, { actor: adminActor(req), action: 'heartbeat_pause', entityId: id, payload: { ok: r.ok } });
    return r;
  }));
  api.post('/user/:id/resume', wrap(async (req) => {
    const id = String(req.params.id);
    const r = await setHeartbeatPaused(sb, id, false);
    await logAdminAction(sb, { actor: adminActor(req), action: 'heartbeat_resume', entityId: id, payload: { ok: r.ok } });
    return r;
  }));

  // Per-user admin controls: model override + daily message limit + hard block.
  // ?tier=main|emotional selects which tier's catalog to return (defaults to main
  // for the legacy single-dropdown caller).
  api.get('/models', wrap(async (req) => {
    const tier = req.query.tier === 'emotional' ? 'emotional' : 'main';
    return { choices: getModelChoices(tier) };
  }));
  api.get('/user/:id/controls', wrap(async (req) => {
    const id = String(req.params.id);
    return { controls: getUserControls(id), usage: await getUsageSnapshot(id) };
  }));
  api.post('/user/:id/controls', wrap(async (req) => {
    const id = String(req.params.id);
    const b = (req.body ?? {}) as { modelOverride?: string; emotionalModel?: string; dailyMessageLimit?: unknown; blocked?: boolean; feedbackMessage?: string; note?: string };
    const next = setUserControls(
      id,
      {
        // modelOverride = MAIN tier (orchestrator + sub-agents); emotionalModel = fast path.
        modelOverride: b.modelOverride,
        emotionalModel: b.emotionalModel,
        dailyMessageLimit: b.dailyMessageLimit as number | null | undefined,
        blocked: b.blocked,
        feedbackMessage: b.feedbackMessage,
        note: b.note,
      },
      'dashboard-admin',
    );
    await logAdminAction(sb, {
      actor: adminActor(req),
      action: 'set_controls',
      entityId: id,
      payload: {
        modelOverride: next.modelOverride,
        emotionalModel: next.emotionalModel,
        dailyMessageLimit: next.dailyMessageLimit,
        blocked: next.blocked,
      },
    });
    return { ok: true, controls: next, usage: await getUsageSnapshot(id) };
  }));

  router.use('/admin/api', api);
  return router;
}

// Constant-time token compare (avoids a timing side-channel on the admin token).
// Returns false on any length mismatch without leaking it through compare time.
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Compare against self so the work is constant regardless of length.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
