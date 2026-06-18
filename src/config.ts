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
    fast: process.env.GEORGE_MODEL_FAST || 'claude-haiku-4-5-20251001',
    smart: process.env.GEORGE_MODEL_SMART || 'claude-sonnet-4-6',
  },
  kimi: {
    apiKey: process.env.KIMI_API_KEY || '',
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
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
  proactive: {
    enabled: process.env.PROACTIVE_ENABLED !== 'false',
    rolloutPct: parseInt(process.env.PROACTIVE_ROLLOUT_PCT || '10'),
  },
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
