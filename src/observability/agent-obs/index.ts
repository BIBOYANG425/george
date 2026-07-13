// Message-observability wiring for george.
//
// This is DISTINCT from ../logger.ts (structured app logging). It records every
// inbound/outbound iMessage into the normalized obs_messages / obs_contacts
// tables (see the boilerplate this was vendored from) so the separate
// Analytics/Inbox/Contacts dashboard can read them.
//
// Design invariants (inherited from @agent-obs/core, do not weaken):
//   • Never hurts the reply path — logMessage/upsertContact enqueue and return;
//     writes are bounded, timed out, and error-swallowing.
//   • Default OFF — gated by GEORGE_MESSAGE_OBSERVABILITY_ENABLED. When off (or
//     when Supabase env is absent, e.g. Mac-side BRIDGE_MODE), getObs() returns
//     a no-op so nothing is imported/enqueued and behavior is byte-identical.
//   • Reuses the SAME SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the db layer uses.

import { createObservability, type Observability, type NormalizedMessage } from './core.js'
import { outboundEvent } from './adapter.js'
import { getFlags } from '../../flags.js'
import { log } from '../logger.js'

const NOOP: Observability = {
  logMessage() {},
  upsertContact() {},
  async resolveOutboundChannel() { return 'unknown' },
  channelFor() { return 'unknown' },
  async seedChannelCache() {},
  setContactOptOut() {},
  async isOptedOut() { return false },
}

/** agent_id partition in obs_messages/obs_contacts — lets one dashboard watch many agents. */
export const OBS_AGENT_ID = process.env.GEORGE_OBS_AGENT_ID || 'george'

/**
 * Resolve the display channel (a dashboard channel-registry key) for a message.
 *
 * Reality check (verified against spectrum-ts in this repo): the shared-pool
 * cloud iMessage provider does NOT surface the Apple sub-transport — it never
 * sets `sender.service` and emits no "SMS"/"RCS", so iMessage vs SMS vs RCS is
 * NOT distinguishable here. The reliable signal is `message.platform`
 * ("iMessage" / "whatsapp-business" / "telegram" / …). We still prefer an
 * explicit service hint when a provider ever supplies one (future-proof, and
 * correct for the boilerplate's other adapters), then fall back to platform.
 * Case-insensitive so it's robust to "iMessage" vs "imessage".
 */
export function resolveChannel(platform: string | undefined, serviceHint?: string | undefined): string {
  const svc = serviceHint?.trim()
  if (svc) {
    switch (svc.toLowerCase()) {
      case 'imessage': return 'iMessage'
      case 'sms': return 'SMS'
      case 'rcs': return 'RCS'
      default: return svc
    }
  }
  switch ((platform || '').toLowerCase()) {
    case 'imessage': return 'iMessage'
    case 'whatsapp':
    case 'whatsapp-business': return 'WhatsApp'
    case 'telegram': return 'Telegram'
    case 'wechat': return 'WeChat'
    case 'slack': return 'Slack'
    default: return platform || 'unknown'
  }
}

let instance: Observability | null = null
let warnedNoEnv = false

/** The observability handle. No-op unless the flag is on AND Supabase env is present. */
export function getObs(): Observability {
  if (!getFlags().messageObservabilityEnabled) return NOOP
  if (instance) return instance
  const supabaseUrl = process.env.SUPABASE_URL || ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!supabaseUrl || !serviceRoleKey) {
    if (!warnedNoEnv) {
      warnedNoEnv = true
      log('warn', 'agent_obs_disabled_no_supabase_env', {})
    }
    return NOOP
  }
  instance = createObservability({
    supabaseUrl,
    serviceRoleKey,
    agentId: OBS_AGENT_ID,
    onError: (context, error) =>
      log('warn', 'agent_obs_write_error', { context, error: error instanceof Error ? error.message : String(error) }),
  })
  return instance
}

export function isObservabilityEnabled(): boolean {
  return getFlags().messageObservabilityEnabled
}

export { outboundEvent }
export type { NormalizedMessage }
