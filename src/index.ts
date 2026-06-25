// Express server entry. Imports ALL_TOOLS (tool count reported at startup),
// mounts WeChat adapter, starts iMessage watcher, boots 5 cron jobs
// (proactive match / reminders / IG + USC scrapes / pending-users GC), and
// loads the skill registry. User control commands (/profile, /correct,
// /pause, /resume, /delete me) are intercepted before the orchestrator in
// both /chat and /imessage/incoming via tryHandleUserCommand. The Path B
// /imessage/incoming route also intercepts onboarding handshake codes
// (legacy "<code>-START" or natural "george (<code>)"); a natural-format
// code that misses pending_users falls through to the orchestrator. All
// other message flow lives in agent/orchestrator.ts.
//
// Transport selection: startServer() branches on loadTransportConfig().transport.
// TRANSPORT=spectrum → dynamic-imports and starts startSpectrumAdapter (never
// loads spectrum-ts on the legacy path). Unset/legacy → original
// startIMessageAdapter() call, unchanged.
//
// Header last reviewed: 2026-06-15

import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import { config, loadTransportConfig } from './config.js'
import { createWeChatRouter } from './adapters/wechat.js'
import { getSpectrumHealth } from './adapters/spectrum-stats.js'
import { isWedged, loadWatchdogConfig } from './adapters/spectrum-watchdog.js'
import { startIMessageAdapter, stopIMessageAdapter } from './adapters/imessage.js'
import { runOrchestrator } from './agent/orchestrator.js'
import { createSupabaseSessionStore } from './agent/session-store.js'
import { getStats, log } from './observability/logger.js'
import { matchStudentsToEvents } from './jobs/proactive.js'
import { sendPendingReminders } from './jobs/reminder-sender.js'
import { sendPendingShippingNotifications } from './jobs/shipping-notifier.js'
import { scrapeInstagram } from './scrapers/instagram.js'
import { scrapeUSCEvents } from './scrapers/usc-events.js'
import { loadAllSkills, getRegistryStats } from './skills/index.js'
import { ALL_TOOLS } from './tools/index.js'
import { enqueueOutgoing, fetchPending, ackOutgoing } from './db/imessage-outgoing.js'
import { supabase } from './db/client.js'
import { createAdminDashboardRouter } from './admin/router.js'
import { auditInjectionBlock } from './admin/actions.js'
import { extractCodeFromStartMessage, runHandshake } from './onboarding/handshake.js'
import { toPublicAssetUrls } from './onboarding/showcase.js'
import { lookupByCode, linkImessageHandle } from './onboarding/pending-users.js'
import { checkInjection, INJECTION_REJECTIONS } from './security/injection-filter.js'
import { startHeartbeatScheduler } from './jobs/heartbeat-scheduler.js'
import { startPendingUsersCleanupCron } from './jobs/pending-users-cleanup-cron.js'
import { runHeartbeat } from './agent/heartbeat.js'
import { createSupabaseRaisedThreadDB } from './agent/grounded-proactive.js'
import { ProfileStore, createSupabaseProfileDB } from './memory/profile.js'
import { createSupabaseObservationDB } from './memory/observations.js'
import { InstructionsStore, createSupabaseInstructionsDB } from './memory/instructions.js'
import { getKVCache } from './memory/kv-cache.js'
import { createDeepSeekClient } from './agent/llm-clients.js'
import { createServiceRoleClient } from './memory/supabase-client.js'
import { tryHandleUserCommand, setUserCommandRuntime } from './agent/user-command-router.js'
import { draftSquadPost } from './services/squad-draft.js'
import { checkRateLimit } from './adapters/rate-limiter.js'
import { stripMarkdown } from './adapters/strip-markdown.js'
import { parseControlTokens, isNoReplyEnabled } from './adapters/split-response.js'
import { captureFactsFromTurn } from './memory/capture.js'
import { runCoordinatorOnce } from './jobs/squad-coordinator.js'
import { buildCoordinatorDeps } from './services/squad-coordinator-deps.js'
import { CRON_EVALUATORS, dispatchEvaluators } from './agent/evaluators/registry.js'
import { setReachEvalDeps } from './agent/evaluators/reach.js'
import { buildReachEvalDeps } from './services/reach-eval-deps.js'
import type { EvalContext } from './agent/evaluators/types.js'

// ALL_TOOLS (imported above) registers all 23 tools as a side effect.

// Instantiated once at module load — createSupabaseSessionStore() creates a
// Supabase client; calling it per-request would leak connections.
const sessionStore = createSupabaseSessionStore()

// Module-level profile-store handle, populated once the heartbeat block
// initializes below. Both /chat and /imessage/incoming pass it to the
// orchestrator. The user-command runtime (cache + supabase + sender) is
// injected into ./agent/user-command-router via setUserCommandRuntime() there.
let _profileStore: ProfileStore | null = null

// Resolve a raw orchestrator reply into what the user should actually receive,
// honoring the {{NO_REPLY}} output-format control token. Returns null to mean
// "send nothing" — only when GEORGE_NOREPLY_ENABLED is on AND George emitted
// {{NO_REPLY}}. Default OFF: with the flag unset this is exactly the previous
// stripMarkdown(raw) — byte-for-byte unchanged, since the feature is gated. When
// ON, the control token is stripped before stripMarkdown so it can never reach a
// user even if the reply also carried real text.
function resolveReply(raw: string): string | null {
  if (!isNoReplyEnabled()) return stripMarkdown(raw)
  const { noReply, text } = parseControlTokens(raw)
  if (noReply) return null
  return stripMarkdown(text)
}

const app = express()

// CORS pinned to known origins. Web chat is relayed server-to-server from
// uscbia.com's /api/george/chat (not browser-direct), but the * wildcard from
// `cors()` would allow any webpage to invoke /stats, /health, or future
// browser-exposed routes from a user's session. List both apex and www so the
// production redirect path keeps working.
app.use(cors({
  origin: [
    'https://uscbia.com',
    'https://www.uscbia.com',
    'https://admin.uscbia.com',
    // Vercel preview deployments under the bia-roommate project (used for PR review).
    /^https:\/\/bia-roommate-[a-z0-9]+-biboyang425s-projects\.vercel\.app$/,
  ],
  credentials: false,
}))

app.use(express.text({ type: 'text/xml' }))
app.use(express.json())

// ==========================================
// ROUTES
// ==========================================

// Spectrum health snapshot for /health, augmented with the honest `wedged`
// degraded boolean (see spectrum-watchdog.isWedged). Additive over the raw
// spectrum-stats snapshot; the raw fields are unchanged.
function spectrumHealthSnapshot() {
  const health = getSpectrumHealth()
  const cfg = loadWatchdogConfig()
  const wedged = isWedged(health, Date.now(), { failSeconds: cfg.failSeconds, silentSeconds: cfg.silentSeconds })
  return { ...health, wedged }
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    character: 'George — BIA 学长',
    tools: Object.keys(ALL_TOOLS).length,
    // Railway injects these — lets anyone verify WHICH build is serving
    // ("is the backend up to date?") without dashboard access.
    build: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    deployedBranch: process.env.RAILWAY_GIT_BRANCH ?? null,
    transport: process.env.TRANSPORT === 'spectrum' ? 'spectrum' : 'legacy',
    // Spectrum inbound-stream telemetry (state, connect/inbound times, error +
    // reconnect counts). Top-level `status` stays 'ok' here even on long inbound
    // silence: spectrum-ts exposes no keepalive/connection-event, so inbound
    // silence cannot be told apart from a legitimately quiet night, and flipping
    // to 'degraded' on quiet would false-alarm every off-peak hour. A recent
    // unrecovered error shows as state:'error'/'reconnecting' with lastError(At);
    // `staleInboundSeconds` is an advisory threshold the dashboard MAY surface.
    // See src/adapters/spectrum-stats.ts header for the library-liveness blocker.
    // `spectrum.wedged` is the HONEST degraded signal: true only when our own
    // reconnect loop has been failing (state error/reconnecting) continuously
    // past the watchdog's fail threshold with no recovery — NOT on a quiet night
    // (state stays 'connected' → wedged stays false). Reported regardless of
    // whether the watchdog is enabled, so /health is honest even before cutover.
    ...(process.env.TRANSPORT === 'spectrum' ? { spectrum: spectrumHealthSnapshot() } : {}),
  })
})

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.adminToken) return res.status(403).json({ error: 'Admin token not configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// Path B auth: separate token for the dedicated iPhone running Shortcuts.
// Compromise of this token only exposes the iMessage queue endpoints, not
// the admin operations gated by ADMIN_TOKEN.
function phoneAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.adminTokenPhone)
    return res.status(403).json({ error: 'phone_token_not_configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token !== config.adminTokenPhone) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// /stats was previously unauthenticated. It exposes aggregate operational
// metrics (active students, message volume, event count). Public observability
// is a credibility leak; gate behind the admin token like /chat.
app.get('/stats', adminAuth, async (_req, res) => {
  try {
    const stats = await getStats()
    res.json(stats)
  } catch (err) {
    log('error', 'stats_endpoint_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

app.use(createWeChatRouter())

// Admin usage dashboard: /admin/dashboard (static SPA) + /admin/api/* (gated by
// ADMIN_TOKEN). OFF by default — this Express app is exposed to the public
// internet via the Cloudflare tunnel (it serves /chat), so mounting the admin
// surface here would make it publicly reachable, gated only by a token already
// distributed to bia-roommate's Vercel relay. Opt in with ADMIN_DASHBOARD_ENABLED=true
// for trusted/local hosts; otherwise view it via the standalone `npm run dashboard`.
if (process.env.ADMIN_DASHBOARD_ENABLED === 'true') {
  app.use(createAdminDashboardRouter(supabase, config.adminToken))
  console.log('[admin] dashboard mounted at /admin/dashboard (ADMIN_DASHBOARD_ENABLED=true)')
}

// Dev test console endpoint — runs the full agent team end-to-end.
// Gated by admin token so it isn't open to the public internet.
app.post('/chat', adminAuth, async (req, res) => {
  try {
    const body = req.body as { userId?: string; text?: string; platform?: 'wechat' | 'imessage' }
    if (!body?.text || typeof body.text !== 'string') {
      return res.status(400).json({ error: 'text is required' })
    }
    const userId = body.userId || 'dev-console'
    const text = body.text
    const channel = body.platform === 'wechat' ? 'web' : 'imessage'

    // User control commands (/profile, /correct, /pause, /resume, /delete me)
    // are handled before the orchestrator so they never incur LLM cost.
    const commandReply = await tryHandleUserCommand(userId, text)
    if (commandReply !== null) {
      return res.json({ response: commandReply })
    }

    // Save user turn before running the orchestrator so the turn is persisted
    // even if the orchestrator fails. save() only writes the last message in the
    // array, so we call it once per turn.
    await sessionStore.save(userId, {
      sessionId: userId,
      messages: [{ role: 'user', content: text }],
      systemContext: {},
    })

    let response = ''
    let turnTelemetry: import('./agent/session-store.js').TurnTelemetry | undefined
    for await (const event of runOrchestrator({ userId, channel, text, sessionStore, profileStore: _profileStore ?? undefined })) {
      const e = event as {
        type?: string
        result?: string
        telemetry?: import('./agent/session-store.js').TurnTelemetry
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (e.type === 'telemetry') {
        turnTelemetry = e.telemetry
      } else if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
        response = e.result
      } else if (e.type === 'assistant' && e.message?.content && response === '') {
        const text = e.message.content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('')
        if (text) response = text
      }
    }

    // Save assistant turn (with per-turn telemetry enrichment when available).
    await sessionStore.save(userId, {
      sessionId: userId,
      messages: [{ role: 'assistant', content: response, telemetry: turnTelemetry }],
      systemContext: {},
    })

    // Fire-and-forget per-turn memory capture (no-op unless MEMORY_CAPTURE_ENABLED).
    if (_profileStore) void captureFactsFromTurn(_profileStore, userId, text, response)

    // Strip {{NO_REPLY}} (and any control token) before sending. On the HTTP
    // /chat path a suppressed reply becomes an empty body — the relay contract is
    // {response:string}, and the web client renders empty as "no reply".
    res.json({ response: resolveReply(response) ?? '' })
  } catch (err) {
    // Log the real error for diagnostics, return a generic message to the
    // caller so upstream stack traces, API keys in error strings (e.g.
    // "invalid api_key sk-ant-..."), or DB connection strings never reach
    // the chat client.
    log('error', 'chat_endpoint_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

// Streaming variant of /chat (Server-Sent Events). ADDITIVE — leaves /chat
// untouched so the existing web relay keeps working. Emits:
//   event: interstitial  {text}   — the "checking…" bubble, as soon as George
//                                    calls a tool (immediate "we got it" feedback)
//   event: message       {response} — the final, markdown-stripped reply
//   event: done          {}
// Token-by-token streaming is a follow-up: in this multi-agent design the final
// text arrives as one 'result' from the dispatched sub-agent, not clean
// top-level token deltas, so smooth per-token streaming needs more plumbing.
app.post('/chat/stream', adminAuth, async (req, res) => {
  try {
    const body = req.body as { userId?: string; text?: string; platform?: 'wechat' | 'imessage' }
    if (!body?.text || typeof body.text !== 'string') {
      return res.status(400).json({ error: 'text is required' })
    }
    const userId = body.userId || 'dev-console'
    const text = body.text
    const channel = body.platform === 'wechat' ? 'web' : 'imessage'

    // Control commands short-circuit before the orchestrator (no LLM cost), same
    // as /chat. Returned as a normal JSON body, not a stream.
    const commandReply = await tryHandleUserCommand(userId, text)
    if (commandReply !== null) {
      return res.json({ response: commandReply })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    await sessionStore.save(userId, {
      sessionId: userId,
      messages: [{ role: 'user', content: text }],
      systemContext: {},
    })

    let response = ''
    let turnTelemetry: import('./agent/session-store.js').TurnTelemetry | undefined
    for await (const event of runOrchestrator({ userId, channel, text, sessionStore, profileStore: _profileStore ?? undefined })) {
      const e = event as {
        type?: string
        result?: string
        text?: string
        telemetry?: import('./agent/session-store.js').TurnTelemetry
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (e.type === 'telemetry') {
        turnTelemetry = e.telemetry
      } else if (e.type === 'interstitial' && e.text) {
        send('interstitial', { text: e.text })
      } else if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
        response = e.result
      } else if (e.type === 'assistant' && e.message?.content && response === '') {
        const t = e.message.content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('')
        if (t) response = t
      }
    }

    // Strip {{NO_REPLY}} (and any control token); a suppressed reply streams an
    // empty message so the SSE client still gets a clean 'message' then 'done'.
    send('message', { response: resolveReply(response) ?? '' })
    send('done', {})
    res.end()

    await sessionStore.save(userId, {
      sessionId: userId,
      messages: [{ role: 'assistant', content: response, telemetry: turnTelemetry }],
      systemContext: {},
    })
    if (_profileStore) void captureFactsFromTurn(_profileStore, userId, text, response)
  } catch (err) {
    log('error', 'chat_stream_endpoint_error', { error: (err as Error).message })
    try { res.end() } catch { /* already closed */ }
  }
})

// Web form assist: given a free-text description, returns a structured draft
// for a 找搭子 post. Called by bia-roommate's "describe one line, george fills
// the form" feature. Gated by adminAuth + per-IP rate limit.
app.post('/squad/draft', adminAuth, async (req, res) => {
  try {
    const body = req.body as { text?: string }
    if (!body?.text || typeof body.text !== 'string' || !body.text.trim()) {
      return res.status(400).json({ error: 'text is required' })
    }
    if (body.text.length > 400) {
      return res.status(400).json({ error: 'text_too_long' })
    }

    // Reuse the same rate limiter as the iMessage path. Key on the request IP
    // so unauthenticated callers that somehow pass adminAuth don't flood Haiku.
    const rateLimitKey = (req.ip ?? req.socket.remoteAddress ?? 'unknown') + ':squad_draft'
    const rl = checkRateLimit(rateLimitKey)
    if (!rl.allowed) {
      return res.status(429).json({ error: 'rate_limit_exceeded' })
    }

    const result = await draftSquadPost(body.text)

    if ('ok' in result) {
      return res.json({ draft: result.draft })
    }
    if (result.error === 'unsupported_category') {
      return res.status(422).json({ error: 'unsupported_category' })
    }
    return res.status(503).json({ error: 'draft_unavailable' })
  } catch (err) {
    log('error', 'squad_draft_endpoint_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

// ──────────────────────────────────────────────────────────────────────
// Path B — iPhone Shortcuts dual-mode endpoints
// ──────────────────────────────────────────────────────────────────────
// When the China side runs iMessage on an iPhone via Apple Shortcuts (no Mac
// available yet), the Shortcut on "When I receive a message" POSTs to
// /imessage/incoming. A second Shortcut polls /imessage/outgoing every minute
// and POSTs an ack per delivered message to /imessage/outgoing/:id/ack.
//
// When the Mac mini comes online (Path A), the iPhone Shortcuts are disabled
// and the Mac mini's imessage adapter takes over by POSTing to /chat directly.
// These endpoints stay mounted but go idle.
//
// All three endpoints are gated by phoneAuth (ADMIN_TOKEN_PHONE) so a
// compromised Shortcut token only exposes the iMessage queue, not the admin
// or relay surfaces.

app.post('/imessage/incoming', phoneAuth, async (req, res) => {
  const body = req.body as { sender?: string; text?: string; timestamp?: number }
  if (!body?.sender || !body.text) {
    return res.status(400).json({ error: 'sender and text required' })
  }
  // Run the injection filter at the HTTP boundary, before the 202 ack and
  // before any agent-loop cost. processMessage runs the same check internally,
  // but for the Shortcut path we want to:
  //   1. avoid the LLM + DB cost on known-bad input;
  //   2. still queue a polite refusal so the user gets feedback;
  //   3. log the attempt at the boundary so phoneAuth-gated abuse stands out.
  const check = checkInjection(body.text)
  if (check.blocked) {
    res.status(202).json({ accepted: true, filtered: 'injection' })
    // Record the boundary block to the admin audit log so it surfaces in the
    // dashboard's injection panel. Non-blocking — never let an audit write hold up
    // the refusal enqueue.
    void auditInjectionBlock(supabase, {
      source: 'imessage_incoming',
      sender: body.sender,
      reason: check.reason,
      textPreview: body.text,
    })
    const rejection =
      INJECTION_REJECTIONS[Math.floor(Math.random() * INJECTION_REJECTIONS.length)]
    try {
      await enqueueOutgoing(body.sender, rejection)
    } catch (err) {
      log('error', 'phone_injection_enqueue_error', { error: (err as Error).message })
    }
    return
  }
  // Ack the Shortcut immediately so the iPhone automation can return; run
  // the orchestrator async and write the response to the outgoing queue when
  // it lands. Polling Shortcut picks it up on the next tick.
  res.status(202).json({ accepted: true })
  void (async () => {
    const userId = body.sender!
    const text = body.text!
    try {
      // Onboarding handshake: incoming text matches "<code>-START" (legacy)
      // or the natural "...george (<code>)" prefill. Routes to the 3-message
      // greeting via the imessage_outgoing queue. A natural-format code that
      // misses the pending_users lookup is treated as a normal conversation
      // and falls through to the orchestrator (runHandshake returns false).
      // The Shortcut consumer runs on a phone that cannot read this host's
      // filesystem, so attachment paths are rewritten to public URLs under
      // ONBOARDING_ASSET_BASE_URL; if that's unset, handshake messages are
      // queued text-only.
      const handshake = extractCodeFromStartMessage(text)
      if (handshake) {
        try {
          const assetBaseUrl = process.env.ONBOARDING_ASSET_BASE_URL
          if (!assetBaseUrl) {
            log('warn', 'handshake_assets_skipped', {
              reason: 'ONBOARDING_ASSET_BASE_URL unset; Path B handshake is text-only',
            })
          }
          const handled = await runHandshake({
            code: handshake.code,
            format: handshake.format,
            imessageHandle: userId,
            sendImessage: async (msg) => {
              const images = msg.imagePaths?.length
                ? toPublicAssetUrls(msg.imagePaths, assetBaseUrl)
                : null
              const files = msg.filePaths?.length
                ? toPublicAssetUrls(msg.filePaths, assetBaseUrl)
                : null
              await enqueueOutgoing(msg.to, {
                text: msg.text,
                images: images ?? undefined,
                files: files ?? undefined,
              })
            },
            lookupPending: (code) => lookupByCode(supabase, code),
            linkImessageHandle: (code, h) => linkImessageHandle(supabase, code, h),
            profileUrlBase:
              process.env.ONBOARDING_PROFILE_URL_BASE ?? 'https://uscbia.com/george/profile',
          })
          if (handled) return
        } catch (err) {
          log('error', 'handshake_error', { error: (err as Error).message })
          return
        }
      }

      // User control commands (/profile, /correct, /pause, /resume, /delete me)
      // are handled before the orchestrator so they never incur LLM cost.
      const commandReply = await tryHandleUserCommand(userId, text)
      if (commandReply !== null) {
        await enqueueOutgoing(userId, commandReply)
        return
      }

      // Save user turn first so it's persisted even if the orchestrator errors.
      await sessionStore.save(userId, {
        sessionId: userId,
        messages: [{ role: 'user', content: text }],
        systemContext: {},
      })

      let reply = ''
      let turnTelemetry: import('./agent/session-store.js').TurnTelemetry | undefined
      for await (const event of runOrchestrator({ userId, channel: 'imessage', text, sessionStore, profileStore: _profileStore ?? undefined })) {
        const e = event as {
          type?: string
          result?: string
          text?: string
          telemetry?: import('./agent/session-store.js').TurnTelemetry
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        if (e.type === 'telemetry') {
          turnTelemetry = e.telemetry
          continue
        }
        // "Checking…" interstitial — send it as its own bubble right away.
        if (e.type === 'interstitial') {
          if (e.text) await enqueueOutgoing(userId, e.text)
          continue
        }
        if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
          reply = e.result
        } else if (e.type === 'assistant' && e.message?.content && reply === '') {
          const text = e.message.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('')
          if (text) reply = text
        }
      }

      if (!reply) return // filtered as automated-message noise

      // Save assistant turn (with per-turn telemetry enrichment when available).
      await sessionStore.save(userId, {
        sessionId: userId,
        messages: [{ role: 'assistant', content: reply, telemetry: turnTelemetry }],
        systemContext: {},
      })

      // Strip {{NO_REPLY}} (and any control token). On this queue-backed iMessage
      // path a suppressed reply means enqueue nothing — George stays silent, same
      // as the empty-reply ("filtered as automated-message noise") case above.
      const outgoing = resolveReply(reply)
      if (outgoing) await enqueueOutgoing(userId, outgoing)

      // Fire-and-forget per-turn memory capture (no-op unless MEMORY_CAPTURE_ENABLED).
      if (_profileStore) void captureFactsFromTurn(_profileStore, userId, text, reply)
    } catch (err) {
      log('error', 'phone_incoming_error', { error: (err as Error).message })
    }
  })()
})

app.get('/imessage/outgoing', phoneAuth, async (req, res) => {
  try {
    const after = typeof req.query.after === 'string' ? req.query.after : undefined
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 10
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 50)) : 10
    const rows = await fetchPending(after, limit)
    res.json(rows)
  } catch (err) {
    log('error', 'phone_outgoing_list_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

app.post('/imessage/outgoing/:id/ack', phoneAuth, async (req, res) => {
  const id = String(req.params.id ?? '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const body = req.body as { status?: 'sent' | 'failed'; error?: string }
  if (body?.status !== 'sent' && body?.status !== 'failed') {
    return res.status(400).json({ error: 'status must be "sent" or "failed"' })
  }
  try {
    await ackOutgoing(id, body.status, body.error)
    res.json({ ok: true })
  } catch (err) {
    log('error', 'phone_outgoing_ack_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

app.post('/admin/scrape-instagram', adminAuth, async (_req, res) => {
  try {
    await scrapeInstagram()
    res.json({ status: 'ok' })
  } catch (err) {
    log('error', 'scrape_instagram_endpoint_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

app.post('/admin/scrape-usc', adminAuth, async (_req, res) => {
  try {
    await scrapeUSCEvents()
    res.json({ status: 'ok' })
  } catch (err) {
    log('error', 'scrape_usc_endpoint_error', { error: (err as Error).message })
    res.status(500).json({ error: 'internal_error' })
  }
})

// ==========================================
// BACKGROUND JOBS (cron)
// ==========================================

cron.schedule('0 */3 * * *', () => {
  matchStudentsToEvents().catch((err) => {
    log('error', 'proactive_cron_error', { error: err.message })
  })
})

cron.schedule('*/5 * * * *', () => {
  sendPendingReminders().catch((err) => {
    log('error', 'reminder_cron_error', { error: err.message })
  })
})

// Drain the shipping-notification queue (parcel/shipment status → WeChat/iMessage).
// Opt-IN kill switch: the producer trigger has enqueued in prod since 2026-06-06,
// so an ungated boot (even local dev with prod creds) would deliver the entire
// pending backlog. Disabled is the safe default; the 24h stale guard in the job
// is a second line of defence.
if (config.shippingNotifier.enabled) {
  cron.schedule('*/5 * * * *', () => {
    sendPendingShippingNotifications().catch((err) => {
      log('error', 'shipping_notifier_cron_error', { error: err.message })
    })
  })
} else {
  log('info', 'shipping_notifier_disabled', {
    hint: 'shipping notification cron NOT scheduled — set SHIPPING_NOTIFIER_ENABLED=true to deliver queued parcel notifications',
  })
}

// Weekly: Mon 12:00 PT (lunchtime). Picked so that:
//   - it lands inside proactive.ts's active window (hour 8-21 LA local), so the
//     immediate matchStudentsToEvents() call below actually runs (eng review
//     2026-05-03 finding A: prior 0 0 * * 1 hit quiet hours and the matcher
//     became dead code)
//   - APIFY Starter $5/mo budget assumes weekly cadence
// Explicit LA timezone so behaviour does not change with the host's TZ env
// (eng review finding C).
cron.schedule(
  '0 12 * * 1',
  async () => {
    try {
      await scrapeInstagram()
      // Inline matcher trigger: proactive cron only sees events with
      // created_at >= now-6h, so without this push the freshly inserted IG
      // batch would be invisible until next week (finding D).
      await matchStudentsToEvents()
    } catch (err) {
      log('error', 'instagram_cron_error', { error: (err as Error).message })
    }
  },
  { timezone: 'America/Los_Angeles' },
)

cron.schedule('0 6 * * *', () => {
  scrapeUSCEvents().catch((err) => {
    log('error', 'usc_cron_error', { error: err.message })
  })
})

// Pending-users GC is an onboarding concern, gated only by its own flag.
// (It previously sat inside the HEARTBEAT_ENABLED block, so disabling
// heartbeats silently disabled GC — two unrelated features coupled.)
if (process.env.ONBOARDING_ENABLED !== 'false') {
  startPendingUsersCleanupCron(supabase)
  console.log('[pending-cleanup] cron scheduled (daily 03:00 LA, purge pending >14 days)')
}

// Squad Coordinator (Phase 4): after-join coordination. Off by default; reuses
// the Spectrum proactive seam. A running-flag skips a tick if the previous is
// still in flight (ticks are cheap but a slow DB shouldn't stack them).
if (process.env.SQUAD_COORDINATION_ENABLED === 'true') {
  const interval = process.env.SQUAD_COORDINATION_INTERVAL_CRON || '*/15 * * * *'
  let running = false
  cron.schedule(interval, async () => {
    if (running) { console.log('[squad-coordinator] previous tick still running, skipping'); return }
    running = true
    const t0 = Date.now()
    try {
      await runCoordinatorOnce(buildCoordinatorDeps())
      console.log(`[squad-coordinator] tick complete in ${Date.now() - t0}ms`)
    } catch (err) {
      console.error('[squad-coordinator] tick failed:', err)
    } finally {
      running = false
    }
  })
  console.log(`[squad-coordinator] enabled (${interval})`)
}

// Re-reach evaluator (Track 2): cron-only nudge for STALLED squad candidates,
// 100% additive and separate from the live coordinator above. Off by default;
// reuses the Spectrum proactive seam via buildReachEvalDeps. Cloned from the
// SQUAD_COORDINATION_ENABLED block (own interval, own running flag, own
// try/catch/log). When the flag is unset this block is never registered — zero
// new cron, zero new queries (incl. the new rereached_at column), zero sends.
if (process.env.SQUAD_REREACH_EVAL_ENABLED === 'true') {
  const interval = process.env.SQUAD_REREACH_EVAL_INTERVAL_CRON || '0 * * * *'
  setReachEvalDeps(buildReachEvalDeps())
  let running = false
  cron.schedule(interval, async () => {
    if (running) { console.log('[rereach-eval] previous tick still running, skipping'); return }
    running = true
    const t0 = Date.now()
    try {
      const ctx: EvalContext = { now: new Date(), trigger: 'cron' }
      await dispatchEvaluators(CRON_EVALUATORS, ctx)
      console.log(`[rereach-eval] tick complete in ${Date.now() - t0}ms`)
    } catch (err) {
      console.error('[rereach-eval] tick failed:', err)
    } finally {
      running = false
    }
  })
  console.log(`[rereach-eval] enabled (${interval})`)
}

// ==========================================
// HEARTBEAT SCHEDULER
// ==========================================

if (process.env.HEARTBEAT_ENABLED !== 'false') {
  const cache = getKVCache();
  const profileStore = new ProfileStore(createSupabaseProfileDB(), cache);
  const instructionsStore = new InstructionsStore(createSupabaseInstructionsDB(), cache);
  const supabase = createServiceRoleClient();
  const llm = createDeepSeekClient();
  const heartbeatDeps = {
    profileStore,
    instructionsStore,
    raisedThreadDb: createSupabaseRaisedThreadDB(),
    // P6 observational-memory — Reflector seam. Harmless when GEORGE_REFLECT_ENABLED
    // is off (the flag gates execution in runHeartbeat).
    observationDB: createSupabaseObservationDB(),
    async loadConfig(userId: string) {
      const { data, error } = await supabase
        .from('user_heartbeat_config')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async loadRecentMessages(userId: string, limit: number) {
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).reverse();
    },
    async loadDueFollowups(userId: string) {
      const { data, error } = await supabase
        .from('student_followups')
        .select('id, content, scheduled_for')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .lte('scheduled_for', new Date().toISOString());
      if (error) throw error;
      return data ?? [];
    },
    // Path B proactive sends go through the shared queue helper. A raw insert
    // here previously wrote columns that don't exist on imessage_outgoing
    // (body/created_at) and a status outside the CHECK constraint ('queued'),
    // so every heartbeat proactive message failed at the DB.
    //
    // NOTE: proactive sends still use the legacy queue (enqueueOutgoing) regardless
    // of the TRANSPORT setting. Spectrum proactive-send requires creating a
    // conversation space to an arbitrary handle — out of scope here. Wiring
    // heartbeat proactive sends through Spectrum is pending the live-cutover phase.
    async sendImessage(msg: { to: string; text: string }) {
      await enqueueOutgoing(msg.to, msg.text);
    },
    async insertFollowup(row: { userId: string; content: string; scheduledFor: string }) {
      const { error } = await supabase.from('student_followups').insert({
        user_id: row.userId,
        content: row.content,
        scheduled_for: row.scheduledFor,
      });
      if (error) throw error;
    },
    async writeLog(entry: any) {
      const { error } = await supabase.from('heartbeat_log').insert(entry);
      if (error) console.error('heartbeat log write failed', error);
    },
    async updateLastHeartbeatAt(userId: string) {
      const { error } = await supabase
        .from('user_heartbeat_config')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) throw error;
    },
    callLLM: llm.call.bind(llm),
  };
  startHeartbeatScheduler({
    async loadAllConfigs() {
      const { data, error } = await supabase.from('user_heartbeat_config').select('*');
      if (error) throw error;
      return data ?? [];
    },
    async runHeartbeat(userId: string) {
      await runHeartbeat(userId, heartbeatDeps);
    },
  });
  console.log('[heartbeat] scheduler started, ticks every 10 minutes');

  // Promote the profile store to module scope so /chat and /imessage/incoming
  // can pass it to the orchestrator, and inject the user-command runtime into
  // the router so tryHandleUserCommand can act on commands.
  _profileStore = profileStore;
  setUserCommandRuntime({
    cache,
    profileStore,
    supabase,
    sendImessage: heartbeatDeps.sendImessage.bind(heartbeatDeps),
  });
}

// User-command routing (/profile, /correct, /pause, /resume, /delete me) now
// lives in ./agent/user-command-router. tryHandleUserCommand is imported above;
// the runtime it needs is injected via setUserCommandRuntime() in the heartbeat
// init block. Kept out of this module so transports can import the router
// without triggering index.ts's server-start side effects.

// ==========================================
// PROCESS RESILIENCE
// ==========================================

process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { error: err.message, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { reason: String(reason) })
})

// Set when the Spectrum adapter is started (spectrum transport only) so the
// shutdown handler can close the connection cleanly instead of orphaning it
// on Photon's side (a dangling connection breaks shared-pool inbound routing).
let stopSpectrum: (() => Promise<void>) | null = null

async function shutdown(signal: string) {
  log('info', 'shutdown', { signal })
  if (stopSpectrum) {
    await stopSpectrum().catch((err) =>
      log('error', 'spectrum_stop_failed', { error: (err as Error).message }),
    )
  }
  await stopIMessageAdapter().catch((err) =>
    log('error', 'imessage_stop_failed', { error: (err as Error).message }),
  )
  process.exit(0)
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

// ==========================================
// START
// ==========================================

async function startServer() {
  try {
    const toolNames = new Set(Object.keys(ALL_TOOLS))
    await loadAllSkills(toolNames)
    log('info', 'skill_registry_loaded', getRegistryStats())
  } catch (err) {
    log('error', 'skill_registry_load_failed', { error: (err as Error).message })
    throw err
  }

  app.listen(config.port, () => {
    log('info', 'server_started', {
      port: config.port,
      tools: Object.keys(ALL_TOOLS).length,
      proactive: config.proactive.enabled,
      rolloutPct: config.proactive.rolloutPct,
    })
    console.log(`\nGeorge (BIA 学长) listening on port ${config.port}`)
    console.log(`  WeChat : http://localhost:${config.port}/wechat`)
    console.log(`  Stats  : http://localhost:${config.port}/stats`)
    console.log(`  Admin  : POST /admin/scrape-instagram, /admin/scrape-usc\n`)
  })

  // Transport selection: TRANSPORT=spectrum routes to the Photon Spectrum
  // adapter; any other value (or unset) keeps the legacy dual-path unchanged.
  // The Spectrum adapter is dynamic-imported here so the legacy default path
  // never touches spectrum-ts at all.
  const transportCfg = loadTransportConfig()
  // Loud, unmissable transport banner: a wrong/missing TRANSPORT silently runs
  // legacy (no Spectrum connection) — make the active mode obvious in deploy logs.
  log('info', 'transport_selected', {
    transport: transportCfg.transport,
    spectrumProjectId: transportCfg.transport === 'spectrum' ? transportCfg.spectrum.projectId : undefined,
    imessageLegacyEnabled: config.imessage.enabled,
  })
  console.log(
    transportCfg.transport === 'spectrum'
      ? `[transport] TRANSPORT=spectrum → connecting to the Spectrum shared pool (project ${transportCfg.spectrum.projectId.slice(0, 8)}…). Watch for "spectrum_connected".`
      : `[transport] TRANSPORT=legacy (or unset) → NO Spectrum connection. Legacy iMessage adapter: ${config.imessage.enabled ? 'enabled' : 'disabled'}. Set TRANSPORT=spectrum for cloud iMessage.`,
  )
  if (transportCfg.transport === 'spectrum') {
    const { startSpectrumAdapter, stopSpectrumAdapter } = await import('./adapters/spectrum.js')
    stopSpectrum = stopSpectrumAdapter // let shutdown() close the connection cleanly
    // Pass the session + profile stores so the orchestrator loads conversation
    // history (same memory wiring as POST /chat); without these george would
    // treat every message in isolation.
    startSpectrumAdapter(transportCfg.spectrum, {
      sessionStore,
      profileStore: _profileStore ?? undefined,
    }).catch((err) => {
      log('warn', 'spectrum_start_failed', { error: (err as Error).message })
      console.warn('Spectrum adapter failed to start.')
    })
  } else {
    // Legacy path (TRANSPORT=legacy or unset) — behavior identical to before.
    startIMessageAdapter().catch((err) => {
      log('warn', 'imessage_start_failed', { error: err.message })
      console.warn('iMessage adapter failed to start, falling back to WeChat only.')
    })
  }
}

startServer().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
