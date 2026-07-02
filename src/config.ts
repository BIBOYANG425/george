// george/src/config.ts
import dotenv from 'dotenv'
dotenv.config()

// Bridge mode = this instance only forwards iMessages to a remote backend.
// Detected from BACKEND_RELAY_URL. In bridge mode the LLM + DB keys are
// not required because this process never makes those calls.
const BRIDGE_MODE = !!process.env.BACKEND_RELAY_URL

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function requiredUnlessBridge(key: string): string {
  const val = process.env[key] || ''
  if (!val && !BRIDGE_MODE) {
    throw new Error(
      `Missing required env var: ${key} (set BACKEND_RELAY_URL to run as a bridge that doesn't need this key)`,
    )
  }
  return val
}

export const config = {
  anthropic: {
    apiKey: requiredUnlessBridge('ANTHROPIC_API_KEY'),
  },
  // Two model tiers, env-overridable. FAST = orchestrator routing + small-talk and
  // the light sub-agents (find-people, whats-happening: single-domain lookup + voice
  // relay). SMART = the high-stakes reasoning sub-agent (know-things: courses,
  // immigration, housing). Defaults are Claude (prod); local dev points them at
  // DeepSeek via GEORGE_MODEL_FAST=deepseek-v4-flash / GEORGE_MODEL_SMART=deepseek-v4-pro
  // in .env (gitignored, never in the PR).
  models: {
    fast: process.env.GEORGE_MODEL_FAST || 'claude-sonnet-4-6',
    smart: process.env.GEORGE_MODEL_SMART || 'claude-sonnet-4-6',
  },
  kimi: {
    apiKey: process.env.KIMI_API_KEY || '',
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
  },
  // Doubao (ByteDance / 火山方舟 Ark) via its Anthropic-compatible endpoint, so
  // the Agent SDK can run George on it just like the DeepSeek /anthropic gateway.
  // When a turn's model is a doubao-* / ark-* id AND apiKey is set, the
  // orchestrator routes THAT query() to this base+key via a per-call env override
  // (see src/agent/model-providers.ts). Set DOUBAO_MODEL as a global tier
  // (GEORGE_MODEL_FAST/SMART=doubao-…) or assign per-user from the dashboard.
  doubao: {
    apiKey: process.env.DOUBAO_API_KEY || '',
    // Ark's Anthropic-protocol endpoint (Coding Plan). NOT /api/v3 (that's the
    // OpenAI-format endpoint the Agent SDK can't speak + separate billing).
    baseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding',
    // e.g. doubao-seed-1.6 / doubao-seed-code-preview-latest / ark-code-latest.
    model: process.env.DOUBAO_MODEL || '',
  },
  supabase: {
    url: requiredUnlessBridge('SUPABASE_URL'),
    anonKey: requiredUnlessBridge('SUPABASE_ANON_KEY'),
    serviceRoleKey: requiredUnlessBridge('SUPABASE_SERVICE_ROLE_KEY'),
  },
  wechat: {
    token: process.env.WECHAT_TOKEN || '',
    appId: process.env.WECHAT_APP_ID || '',
    appSecret: process.env.WECHAT_APP_SECRET || '',
  },
  imessage: {
    enabled: process.env.IMESSAGE_ENABLED === 'true',
  },
  shippingNotifier: {
    // Opt-IN kill switch. The parcel producer has enqueued in prod since
    // 2026-06-06, so an ungated boot would blast the backlog. Default off; set
    // SHIPPING_NOTIFIER_ENABLED=true to start delivering (queue-health check +
    // dry-run first).
    enabled: process.env.SHIPPING_NOTIFIER_ENABLED === 'true',
  },
  // When set on a bridge-mode deployment (e.g. Mac mini), the iMessage adapter
  // forwards new messages to this URL instead of calling processMessage locally.
  // Used by the Mac mini bridge to reach the Cloudflare Container backend.
  // Leave empty on the Container itself.
  backendRelayUrl: process.env.BACKEND_RELAY_URL || '',
  biaRoommate: {
    baseUrl: process.env.BIA_ROOMMATE_API_URL || 'http://localhost:3000',
  },
  apify: {
    token: process.env.APIFY_TOKEN || '',
  },
  adminToken: process.env.ADMIN_TOKEN || '',
  // Separate token for the iPhone Shortcuts Path B endpoints.
  // The dedicated iPhone holds this token in its Shortcut definitions; the
  // Container validates it on /imessage/incoming, /imessage/outgoing, and
  // /imessage/outgoing/:id/ack. Keeping it distinct from ADMIN_TOKEN limits
  // blast radius if the iPhone's Shortcuts get exfiltrated.
  adminTokenPhone: process.env.ADMIN_TOKEN_PHONE || '',
  port: parseInt(process.env.PORT || '3001'),
  // Concierge match glance (squad lane). DEFAULT-OFF: when false, create_squad_post keeps today's
  // auto ping fan-out (triggerPingFanout). When true, matches are queued to proposed_matches for an
  // officer glance (admin link OR iMessage /ok) before George fires the intro. See docs / plan.
  concierge: {
    matchEnabled: process.env.CONCIERGE_MATCH_ENABLED === 'true',
    // Officer iMessage handle (E.164 phone or email) allowed to approve/reject via /ok /no. Compared
    // AFTER normalizeHandle. REQUIRED when matchEnabled: the officer notify is the ONLY surface that
    // delivers the approve link (there is no dashboard queue), so if this is empty, proposals are
    // queued but reach nobody. index.ts warns at boot when matchEnabled && this is empty.
    officerImessage: process.env.CONCIERGE_OFFICER_IMESSAGE || '',
    // Public base URL of the AGENT service (the one with a Spectrum connection) for the approve link.
    // NOT the dashboard — george.uscbia.com has no Spectrum. e.g. https://george-api.uscbia.com
    publicBaseUrl: process.env.CONCIERGE_PUBLIC_BASE_URL || '',
    // T7 proactive surfacer (squad branch): George proactively proposes an open squad post to a
    // passive opted-in student, routed through the SAME officer glance. Independent of matchEnabled
    // so the reactive glance can ship first. DEFAULT-OFF. (The event branch is the existing
    // matchStudentsToEvents cron, gated by PROACTIVE_ENABLED — it writes no proposed_matches.)
    proactiveEnabled: process.env.CONCIERGE_PROACTIVE_ENABLED === 'true',
  },
  // Code-level anti-fabrication gate on the fast path. When on (default), a
  // fast-path draft that asserts a specific unverified fact (a shop, a gathering,
  // an opening hour, a course number, a price) is dropped and the turn falls
  // through to the grounded full agent. Kill-switch: FASTPATH_FABRICATION_GUARD=false.
  fastPathFabricationGuard: process.env.FASTPATH_FABRICATION_GUARD !== 'false',
  proactive: {
    enabled: process.env.PROACTIVE_ENABLED !== 'false',
    rolloutPct: parseInt(process.env.PROACTIVE_ROLLOUT_PCT || '10'),
  },
  // NOTE: the P4 grounded-proactive flag (GROUNDED_PROACTIVE_ENABLED) is read at
  // call time by isGroundedProactiveEnabled() in src/agent/grounded-proactive.ts
  // (same precedent as MEMORY_CAPTURE_ENABLED in src/memory/capture.ts), so it is
  // intentionally NOT surfaced here — that keeps the heartbeat module free of
  // this file's eager required-env validation. DEFAULT-OFF when unset.
}

export type TransportMode = 'spectrum' | 'legacy'

// Selects the iMessage transport. Defaults to 'legacy' (the self-hosted
// dual-path) so a missing var never silently cuts over. Set TRANSPORT=spectrum
// to use the Photon Spectrum adapter.
export function loadTransportConfig() {
  // Fail fast on a typo'd value rather than silently running legacy.
  const raw = process.env.TRANSPORT
  if (raw !== undefined && raw !== '' && raw !== 'spectrum' && raw !== 'legacy') {
    throw new Error(`Invalid TRANSPORT="${raw}" (use 'spectrum' or 'legacy')`)
  }
  const transport: TransportMode = raw === 'spectrum' ? 'spectrum' : 'legacy'
  const spectrum = {
    // Accept the namespaced SPECTRUM_* names (preferred in george's shared
    // .env) OR the bare PROJECT_ID/PROJECT_SECRET that `bun create
    // spectrum-project` scaffolds, so a scaffolded .env works unchanged.
    projectId: process.env.SPECTRUM_PROJECT_ID || process.env.PROJECT_ID || '',
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET || process.env.PROJECT_SECRET || '',
    imessageAddress: process.env.SPECTRUM_IMESSAGE_ADDRESS || '',
    imessageToken: process.env.IMESSAGE_TOKEN || '',
  }
  // In spectrum mode the creds are required to connect; surface that at startup
  // instead of failing opaquely on the first message.
  if (transport === 'spectrum' && (!spectrum.projectId || !spectrum.projectSecret)) {
    throw new Error(
      'TRANSPORT=spectrum requires SPECTRUM_PROJECT_ID (or PROJECT_ID) and SPECTRUM_PROJECT_SECRET (or PROJECT_SECRET)',
    )
  }
  return { transport, spectrum }
}
