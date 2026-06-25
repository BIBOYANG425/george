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

// Pull the model id out of the turn's tool_calls telemetry blob (it carries
// model/cost/channel — see analytics.ts). Returns null when absent or malformed.
function modelFromToolCalls(tc: unknown): string | null {
  if (tc && typeof tc === 'object') {
    const m = (tc as { model?: unknown }).model;
    if (typeof m === 'string' && m) return m;
  }
  return null;
}

// Flag a George turn as a bad reply for AI-quality review. The snapshot is built
// SERVER-SIDE from the authoritative messages row (not trusted from the client),
// so the recorded run context (content/model/agent/tool_calls) is what actually
// produced the turn. A missing message row still records the flag (with an empty
// snapshot) — the human flagged something they saw, and losing that to a since-
// deleted row would be worse than a thin record. Every flag also writes an
// admin_audit_log row via logAdminAction. Returns {ok} — never throws.
export async function flagMessage(
  sb: SupabaseClient,
  input: { messageId: string; kind: string; reason?: string; actor: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Authoritative snapshot source: the live message row.
    const { data: msg, error: readErr } = await sb
      .from('messages')
      .select('user_id, content, agent, tool_calls, created_at')
      .eq('id', input.messageId)
      .maybeSingle();

    const row = (msg ?? null) as
      | { user_id: string | null; content: string | null; agent: string | null; tool_calls: unknown; created_at: string | null }
      | null;

    // message_id is a FK to messages(id) (on delete set null). Inserting an id that
    // no longer exists would VIOLATE the FK, so only set it when the row was actually
    // found; otherwise null + keep the attempted id in the snapshot. We also record
    // whether the row was simply gone vs. unreadable (read error) so a transient DB
    // failure doesn't masquerade as "message deleted".
    const { error } = await sb.from('message_flags').insert({
      message_id: row ? input.messageId : null,
      user_id: row?.user_id ?? null,
      kind: input.kind,
      reason: input.reason ?? null,
      model: modelFromToolCalls(row?.tool_calls),
      agent: row?.agent ?? null,
      tool_calls: row?.tool_calls ?? null,
      context_snapshot: {
        content: row?.content ?? null,
        createdAt: row?.created_at ?? null,
        attemptedMessageId: input.messageId,
        snapshotMissing: row ? undefined : readErr ? 'read_error' : 'message_gone',
      },
      actor: input.actor,
    });
    if (error) return { ok: false, error: error.message };

    await logAdminAction(sb, {
      actor: input.actor,
      action: 'flag_message',
      entityId: input.messageId,
      entityType: 'message',
      payload: { kind: input.kind, reason: input.reason ?? null },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
