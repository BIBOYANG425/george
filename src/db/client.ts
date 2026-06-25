// The shared service-role Supabase client.
//
// Reads SUPABASE_* DIRECTLY from the environment instead of importing config.ts.
// Why: importing config.ts runs its top-level requiredUnlessBridge('ANTHROPIC_API_KEY'),
// so any module that transitively imports this client would crash a process that
// has no Anthropic key. The admin dashboard service (scripts/dashboard-server.ts)
// is exactly that case — it reaches this client via src/admin/resolve.ts →
// src/db/students.ts and needs Supabase but NOT an LLM key. The db layer genuinely
// depends only on SUPABASE_*, so it should not drag in the agent's LLM config.
//
// Bridge-tolerance mirrors config.ts exactly: in BRIDGE_MODE (BACKEND_RELAY_URL set)
// the Mac-side relay never makes DB calls, so empty values are accepted; everywhere
// else the two vars are required and a missing one fails fast — byte-identical to
// the previous config.supabase.{url,serviceRoleKey} behavior.
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// Load .env in the module body (NOT a side-effect `import 'dotenv/config'`) so it
// re-runs under vitest's vi.resetModules(), matching config.ts exactly.
dotenv.config()

const BRIDGE_MODE = !!process.env.BACKEND_RELAY_URL

function requiredUnlessBridge(key: string): string {
  const val = process.env[key] || ''
  if (!val && !BRIDGE_MODE) {
    throw new Error(`Missing required env var: ${key}`)
  }
  return val
}

export const supabase = createClient(
  requiredUnlessBridge('SUPABASE_URL'),
  requiredUnlessBridge('SUPABASE_SERVICE_ROLE_KEY'),
)
