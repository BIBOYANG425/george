// src/admin/actions.ts
//
// Admin dashboard WRITE + AUDIT layer. analytics.ts is read-only by contract
// (its header says so); every mutating admin action and its audit trail lives
// here instead, so the audit hook has a single home (PR-0 of the dashboard
// expansion; later PRs move setHeartbeatPaused/setUserControls writes in here
// too and add flag/clear-block/delete).
//
// Audit reuses the EXISTING admin_audit_log table (shape:
// actor_email/action/entity_type/entity_id/payload), already written by the
// user-command path (src/agent/user-command-router.ts). We do NOT create a
// second audit table.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { log } from '../observability/logger.js';

// The acting admin's identity. In prod the dashboard sits behind Cloudflare
// Access, which injects the authenticated email as a request header — that is
// the real actor. Locally (no Access) or if the header is absent we fall back
// to 'admin-token' so the row is still attributable to "someone holding the
// shared token" rather than dropping the audit entirely.
export function adminActor(req: Request): string {
  const email = req.headers['cf-access-authenticated-user-email'];
  return typeof email === 'string' && email.trim() ? email.trim() : 'admin-token';
}

export interface AdminAuditEntry {
  actor: string;
  action: string;
  entityId: string;
  entityType?: string;
  payload?: Record<string, unknown>;
}

// Append one row to admin_audit_log. NEVER throws — a failed audit must not fail
// the underlying admin action. But unlike the user-command path's fully-silent
// swallow, we emit a `warn` so a broken audit trail is OBSERVABLE (an audit log
// that silently stops recording is worse than no audit log — the value of the
// audit is that every write lands).
export async function logAdminAction(sb: SupabaseClient, entry: AdminAuditEntry): Promise<void> {
  try {
    const { error } = await sb.from('admin_audit_log').insert({
      actor_email: entry.actor,
      action: entry.action,
      entity_type: entry.entityType ?? 'user',
      entity_id: entry.entityId,
      payload: entry.payload ?? {},
    });
    if (error) log('warn', 'admin_audit_write_failed', { action: entry.action, error: error.message });
  } catch (err) {
    log('warn', 'admin_audit_write_failed', { action: entry.action, error: (err as Error).message });
  }
}
