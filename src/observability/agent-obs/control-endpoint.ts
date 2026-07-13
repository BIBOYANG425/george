// Human-in-loop control endpoint for the observability dashboard's Inbox composer.
//
// SECURITY POSTURE (george's Express app is tunnel-exposed, so be strict):
//   • OPT-IN: mounts NOTHING unless AGENT_CONTROL_SECRET is set AND message
//     observability is enabled. No secret → no send endpoint, ever.
//   • Every request must present a matching `x-agent-secret` (constant-time
//     compare). No secret echoed in responses or logs.
//   • Opt-out compliance: refuses to send to a contact that has opted out.
//   • Namespaced under /observ so it can't collide with george's routes.
//     Point the dashboard's AGENT_CONTROL_URL at http://<george-host>/observ.
//
// The actual send reuses george's live Spectrum client (sendProactive), and the
// outbound row is logged automatically by the createSpectrumClient onOutbound
// hook — no double-logging here.

import type { Express, Request, Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { getObs, isObservabilityEnabled } from './index.js'
import { getActiveSpectrumClient } from '../../adapters/spectrum.js'
import { log } from '../logger.js'

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function mountAgentControlEndpoint(app: Express): void {
  const secret = process.env.AGENT_CONTROL_SECRET || ''
  if (!isObservabilityEnabled() || !secret) return // opt-in: no secret → no endpoint

  app.get('/observ/health', (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  app.post('/observ/send', async (req: Request, res: Response) => {
    if (!secretMatches(req.header('x-agent-secret'), secret)) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const body = (req.body ?? {}) as { conversationId?: unknown; text?: unknown }
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
    const text = typeof body.text === 'string' ? body.text : ''
    if (!conversationId || !text.trim()) {
      res.status(400).json({ error: 'conversationId and text are required' })
      return
    }
    try {
      if (await getObs().isOptedOut(conversationId)) {
        res.status(409).json({ error: 'opted_out' })
        return
      }
      const client = getActiveSpectrumClient()
      if (!client) {
        res.status(503).json({ error: 'no_transport' })
        return
      }
      await client.sendProactive(conversationId, [text])
      log('info', 'agent_control_send', { handlePrefix: conversationId.slice(0, 4), chars: text.length })
      res.json({ ok: true })
    } catch (err) {
      log('warn', 'agent_control_send_error', { error: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ error: 'send_failed' })
    }
  })

  log('info', 'agent_control_endpoint_mounted', { path: '/observ/send' })
}
