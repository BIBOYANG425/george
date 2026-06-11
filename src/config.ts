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
  const transport: TransportMode =
    process.env.TRANSPORT === 'spectrum' ? 'spectrum' : 'legacy'
  return {
    transport,
    spectrum: {
      projectId: process.env.SPECTRUM_PROJECT_ID || '',
      projectSecret: process.env.SPECTRUM_PROJECT_SECRET || '',
      imessageAddress: process.env.SPECTRUM_IMESSAGE_ADDRESS || '',
      imessageToken: process.env.IMESSAGE_TOKEN || '',
    },
  }
}
