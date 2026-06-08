// Express server entry. Imports ALL_TOOLS (tool count reported at startup),
// mounts WeChat adapter, starts
// iMessage watcher, boots 4 cron jobs (proactive match / reminders / IG + USC
// scrapes), and loads the skill registry. User control commands (/profile,
// /correct, /pause, /resume, /delete me) are intercepted before the
// orchestrator in both /chat and /imessage/incoming via tryHandleUserCommand.
// Nothing else routes through this file at runtime — message flow lives in
// agent/orchestrator.ts.
//
// Header last reviewed: 2026-06-07

import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import { config } from './config.js'
import { createWeChatRouter } from './adapters/wechat.js'
import { startIMessageAdapter, stopIMessageAdapter } from './adapters/imessage.js'
import { runOrchestrator } from './agent/orchestrator.js'
import { createSupabaseSessionStore } from './agent/session-store.js'
import { getStats, log } from './observability/logger.js'
import { matchStudentsToEvents } from './jobs/proactive.js'
import { sendPendingReminders } from './jobs/reminder-sender.js'
import { scrapeInstagram } from './scrapers/instagram.js'
import { scrapeUSCEvents } from './scrapers/usc-events.js'
import { loadAllSkills, getRegistryStats } from './skills/index.js'
import { ALL_TOOLS } from './tools/index.js'
import { enqueueOutgoing, fetchPending, ackOutgoing } from './db/imessage-outgoing.js'
import { checkInjection, INJECTION_REJECTIONS } from './security/injection-filter.js'
import { startHeartbeatScheduler } from './jobs/heartbeat-scheduler.js'
import { runHeartbeat } from './agent/heartbeat.js'
import { ProfileStore, createSupabaseProfileDB } from './memory/profile.js'
import { InstructionsStore, createSupabaseInstructionsDB } from './memory/instructions.js'
import { getKVCache, KVCache } from './memory/kv-cache.js'
import { createDeepSeekClient } from './agent/llm-clients.js'
import { createServiceRoleClient } from './memory/supabase-client.js'
import { parseAndRouteUserCommand, executeUserCommand, UserCommandDeps } from './tools/user-commands.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// ALL_TOOLS (imported above) registers all 23 tools as a side effect.

// Instantiated once at module load — createSupabaseSessionStore() creates a
// Supabase client; calling it per-request would leak connections.
const sessionStore = createSupabaseSessionStore()

// Module-level handles for memory + user-command deps, populated once the
// heartbeat block initializes below. Both /chat and /imessage/incoming check
// these before dispatching to the orchestrator.
let _cache: KVCache | null = null
let _profileStore: ProfileStore | null = null
let _supabase: SupabaseClient | null = null
let _sendImessage: ((msg: { to: string; text: string }) => Promise<void>) | null = null

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

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    character: 'George — BIA 学长',
    tools: Object.keys(ALL_TOOLS).length,
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

    const collectedText: string[] = []
    for await (const event of runOrchestrator({ userId, channel, text, sessionStore })) {
      if (event.type === 'text' && event.text) {
        collectedText.push(event.text)
      }
    }
    const response = collectedText.join('')

    // Save assistant turn.
    await sessionStore.save(userId, {
      sessionId: userId,
      messages: [{ role: 'assistant', content: response }],
      systemContext: {},
    })

    res.json({ response })
  } catch (err) {
    // Log the real error for diagnostics, return a generic message to the
    // caller so upstream stack traces, API keys in error strings (e.g.
    // "invalid api_key sk-ant-..."), or DB connection strings never reach
    // the chat client.
    log('error', 'chat_endpoint_error', { error: (err as Error).message })
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

      const collectedText: string[] = []
      for await (const event of runOrchestrator({ userId, channel: 'imessage', text, sessionStore })) {
        if (event.type === 'text' && event.text) {
          collectedText.push(event.text)
        }
      }
      const reply = collectedText.join('')

      if (!reply) return // filtered as automated-message noise

      // Save assistant turn.
      await sessionStore.save(userId, {
        sessionId: userId,
        messages: [{ role: 'assistant', content: reply }],
        systemContext: {},
      })

      await enqueueOutgoing(userId, reply)
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
    async sendImessage(msg: { to: string; text: string }) {
      await supabase.from('imessage_outgoing').insert({
        recipient: msg.to,
        body: msg.text,
        status: 'queued',
        created_at: new Date().toISOString(),
      });
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

  // Promote to module scope so /chat and /imessage/incoming can use them.
  _cache = cache;
  _profileStore = profileStore;
  _supabase = supabase;
  _sendImessage = heartbeatDeps.sendImessage.bind(heartbeatDeps);
}

// ==========================================
// USER COMMAND ROUTING (shared helper)
// ==========================================
//
// Builds the full UserCommandDeps object from the module-level singletons.
// Returns null when the memory layer hasn't been initialised (HEARTBEAT_ENABLED=false).
function buildUserCommandDeps(): UserCommandDeps | null {
  if (!_cache || !_profileStore || !_supabase || !_sendImessage) return null;
  const cache = _cache;
  const profileStore = _profileStore;
  const supabase = _supabase;
  const sendImessage = _sendImessage;
  return {
    profileStore,
    async setPaused(userId: string, until: Date | null) {
      await supabase
        .from('user_heartbeat_config')
        .update({ paused: until !== null, pause_until: until?.toISOString() ?? null })
        .eq('user_id', userId);
      await cache.delete(`user:${userId}:profile`);
    },
    async deleteUserData(userId: string) {
      await Promise.all([
        supabase.from('user_profiles').delete().eq('user_id', userId),
        supabase.from('user_heartbeat_config').delete().eq('user_id', userId),
        supabase.from('user_heartbeat_instructions').delete().eq('user_id', userId),
        supabase.from('heartbeat_log').delete().eq('user_id', userId),
        supabase.from('student_followups').delete().eq('user_id', userId),
        supabase.from('messages').delete().eq('user_id', userId),
      ]);
      await cache.delete(`user:${userId}:profile`);
      await cache.delete(`user:${userId}:instructions`);
    },
    sendImessage,
    async setDeleteConfirmPending(userId: string, pending: boolean) {
      await cache.set(`user:${userId}:delete_pending`, pending ? '1' : '0', 300);
    },
    async getDeleteConfirmPending(userId: string) {
      return (await cache.get(`user:${userId}:delete_pending`)) === '1';
    },
    async writeAudit(entry: { userId: string; action: string; payload: Record<string, unknown> }) {
      try {
        await supabase.from('admin_audit_log').insert({
          actor_email: 'system@george',
          action: entry.action,
          entity_type: 'user',
          entity_id: entry.userId,
          payload: entry.payload,
        });
      } catch {
        // admin_audit_log may not exist yet; swallow so commands don't fail
      }
    },
  };
}

/**
 * Attempt to handle a user command message before the orchestrator sees it.
 * Returns the reply string if handled, or null if not a command (or memory
 * layer is uninitialised).
 */
async function tryHandleUserCommand(
  userId: string,
  text: string,
): Promise<string | null> {
  const parsed = parseAndRouteUserCommand(text);
  if (parsed === null) return null;
  const deps = buildUserCommandDeps();
  if (deps === null) {
    // Memory layer off — fall through to orchestrator
    return null;
  }
  return executeUserCommand(userId, parsed, deps, text);
}

// ==========================================
// PROCESS RESILIENCE
// ==========================================

process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { error: err.message, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { reason: String(reason) })
})

async function shutdown(signal: string) {
  log('info', 'shutdown', { signal })
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

  startIMessageAdapter().catch((err) => {
    log('warn', 'imessage_start_failed', { error: err.message })
    console.warn('iMessage adapter failed to start, falling back to WeChat only.')
  })
}

startServer().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
