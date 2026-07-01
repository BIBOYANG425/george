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
  getDistressQueue,
  getInjectionLog,
} from './analytics.js';
import { renderDashboardHtml } from './dashboard-html.js';
import { getUserControls, setUserControls, getUsageSnapshot, getModelChoices } from './user-controls.js';
import { logAdminAction, adminActor, flagMessage, clearProfileBlock, deleteObservation } from './actions.js';
import { ProfileStore, createSupabaseProfileDB } from '../memory/profile.js';
import { getKVCache } from '../memory/kv-cache.js';
import { createSupabaseObservationDB } from '../memory/observations.js';
// Config-free pure engine (safe to import statically). buildProposalDeps (which pulls config, and
// thus ANTHROPIC_API_KEY that the dashboard service lacks) is imported LAZILY in the POST handler.
import { sendApprovedMatch, rejectMatch } from '../services/match-proposal-engine.js';

export function createAdminDashboardRouter(sb: SupabaseClient, adminToken: string): express.Router {
  const router = express.Router();

  // Memory stores for the destructive endpoints. ProfileStore is built with the
  // SAME KV cache the agent uses (getKVCache) so a clear-block busts the shared
  // edge cache, not a private copy. Built lazily/once per router.
  const profileStore = new ProfileStore(createSupabaseProfileDB(), getKVCache());
  const observationDB = createSupabaseObservationDB();

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

  // Review = safety + AI quality. Crisis queue first (the thing a human must act on
  // fastest), then flagged turns, fabrication suspects, and the injection log. All
  // read-only + fail-soft; the crisis queue is gated OFF until the SOP exists.
  api.get('/review', wrap(async () => {
    const [crisis, flagged, fab, injection] = await Promise.all([
      getDistressQueue(sb, {}),
      getFlaggedTurns(sb, 100),
      getFabricationSuspects(sb, {}),
      getInjectionLog(sb, 50),
    ]);
    return { crisis, flagged, fabrication: fab, injection };
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

  // ── DESTRUCTIVE memory ops (PR-N) — handle → resolved uuid, audited, fail-loud ──
  // Clear one profile block. Goes through ProfileStore (busts KV); audit snapshots
  // the original value for recovery. :id is the channel handle from the drawer.
  api.post('/user/:id/memory/clear-block', wrap(async (req) => {
    const handle = String(req.params.id);
    const block = String((req.body ?? {}).block ?? '');
    const r = await clearProfileBlock(sb, profileStore, handle, block, adminActor(req));
    if (!r.ok) throw new Error(r.error || 'clear failed'); // surface as non-2xx (no false success)
    return r;
  }));
  // Delete one observation (owner-scoped by the resolved uuid). :oid is a bigint id.
  api.post('/user/:id/observation/:oid/delete', wrap(async (req) => {
    const handle = String(req.params.id);
    const oid = parseInt(String(req.params.oid), 10);
    const r = await deleteObservation(sb, observationDB, handle, oid, adminActor(req));
    if (!r.ok) throw new Error(r.error || 'delete failed');
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

  // ── Concierge match glance: officer approve/reject ──────────────────────────
  // On the OUTER router (NOT `api`, whose api.use(auth) demands the ADMIN token) and registered
  // BEFORE the /admin/api mount, so an officer's approve LINK carrying only the per-row nonce (?k=)
  // is authorized. Runs in the AGENT service (the one with Spectrum) — links point there; the
  // dashboard also mounts this router but has no Spectrum, so links are never pointed at it.
  const matchHtml = (body: string): string =>
    '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
    '<title>George</title><body style="font-family:-apple-system,system-ui;max-width:32rem;margin:3rem auto;' +
    'padding:0 1.2rem;color:#71031F"><h2>George 找搭子</h2>' + body + '</body>';

  const loadMatchAndAuth = async (
    req: express.Request,
  ): Promise<{ ok: true; id: string; post_id: string; status: string } | { ok: false; status: number; msg: string }> => {
    const id = String(req.params.id);
    const { data, error } = await sb
      .from('proposed_matches')
      .select('id, post_id, approve_token, status')
      .eq('id', id)
      .maybeSingle();
    if (error) return { ok: false, status: 500, msg: 'lookup failed' };
    if (!data) return { ok: false, status: 404, msg: '匹配不存在' };
    const row = data as { id: string; post_id: string; approve_token: string; status: string };
    const bearer = req.headers.authorization?.replace('Bearer ', '');
    const hdr = typeof req.headers['x-admin-token'] === 'string' ? (req.headers['x-admin-token'] as string) : undefined;
    const qTok = typeof req.query.token === 'string' ? req.query.token : undefined;
    const adminProvided = bearer || hdr || qTok || '';
    const nonce = typeof req.query.k === 'string' ? req.query.k : '';
    // Admin token (bearer / x-admin-token / ?token=) OR the per-row approve_token nonce (?k=).
    const authed = (!!adminToken && safeEqual(adminProvided, adminToken)) || safeEqual(nonce, row.approve_token);
    if (!authed) return { ok: false, status: 401, msg: 'unauthorized' };
    return { ok: true, id: row.id, post_id: row.post_id, status: row.status };
  };

  for (const action of ['approve', 'reject'] as const) {
    // GET → confirmation page only. A link-preview / scanner GET must NEVER act; only the POST does.
    router.get('/admin/api/match/:id/' + action, async (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const a = await loadMatchAndAuth(req);
      if (!a.ok) { res.status(a.status).send(matchHtml('<p>' + a.msg + '</p>')); return; }
      if (a.status !== 'pending') { res.send(matchHtml('<p>这个匹配已经处理过了 (' + a.status + ')。</p>')); return; }
      // Carry whichever credential authed the GET onto the POST (officer link uses ?k=, an admin
      // may use ?token=), so the confirm button doesn't 401.
      const cred =
        typeof req.query.k === 'string' ? 'k=' + encodeURIComponent(req.query.k)
        : typeof req.query.token === 'string' ? 'token=' + encodeURIComponent(req.query.token)
        : '';
      const kq = cred ? '?' + cred : '';
      const label = action === 'approve' ? '确认发送' : '确认拒绝';
      res.send(matchHtml(
        '<p>' + (action === 'approve' ? '发送这个搭子匹配给对方?' : '拒绝这个匹配?') + '</p>' +
        '<form method="POST" action="/admin/api/match/' + a.id + '/' + action + kq + '">' +
        '<button style="font-size:1.1rem;padding:.6rem 1.4rem;background:#71031F;color:#fff;border:0;border-radius:.5rem">' +
        label + '</button></form>'));
    });
    // POST → perform the action. Agent service only (has Spectrum). deps imported lazily (config).
    router.post('/admin/api/match/:id/' + action, async (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const a = await loadMatchAndAuth(req);
      if (!a.ok) { res.status(a.status).send(matchHtml('<p>' + a.msg + '</p>')); return; }
      const officer = adminActor(req);
      try {
        const { buildProposalDeps } = await import('../services/match-proposal-deps.js');
        const deps = await buildProposalDeps(a.post_id);
        if (action === 'approve') {
          const r = await sendApprovedMatch(a.id, officer, deps);
          await logAdminAction(sb, { actor: officer, action: 'match_approve', entityId: a.id, payload: { outcome: r.outcome } });
          const msg = r.outcome === 'sent' ? '已发送 ✅ 搭子已经收到啦'
            : r.outcome === 'noop' ? '这个匹配已经处理过了'
            : '没有发送 — 对方可能静音了 / 局满了 / 到时间了';
          res.send(matchHtml('<p>' + msg + '</p>'));
        } else {
          const r = await rejectMatch(a.id, officer, deps);
          await logAdminAction(sb, { actor: officer, action: 'match_reject', entityId: a.id, payload: { outcome: r.outcome } });
          res.send(matchHtml('<p>' + (r.outcome === 'rejected' ? '已拒绝 🫡' : '这个匹配已经处理过了') + '</p>'));
        }
      } catch (err) {
        console.error('[admin] match action error:', (err as Error).message);
        res.status(500).send(matchHtml('<p>出错了: ' + (err as Error).message + '</p>'));
      }
    });
  }

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
