// src/admin/actions.ts
//
// Admin dashboard WRITE + AUDIT layer. analytics.ts is read-only by contract
// (its header says so); every mutating admin action and its audit trail lives
// here instead, so the audit hook has a single home (PR-0 of the dashboard
// expansion; later PRs move setHeartbeatPaused/setUserControls writes in here
// too and add flag/clear-block/delete).
//
// Audit reuses the EXISTING admin_audit_log table (owned by bia-admin; actual
// prod shape: admin_email/action/entity_type/entity_id/payload/ts). We do NOT
// create a second audit table. NOTE: the column is `admin_email` (not actor_email)
// and the timestamp is `ts` (not created_at) — george code previously wrote
// actor_email, which silently failed every insert (the table rejects an unknown
// column and the write is swallowed). This module uses the real names.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { log } from '../observability/logger.js';
import { resolveProfileKey } from './resolve.js';
import { BLOCK_NAMES, type BlockName, type ProfileStore } from '../memory/profile.js';
import type { ObservationDB } from '../memory/observations.js';

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
      admin_email: entry.actor, // real prod column is admin_email, NOT actor_email
      action: entry.action,
      entity_type: entry.entityType ?? 'user',
      entity_id: entry.entityId,
      payload: entry.payload ?? {},
      // `ts` has a default (now()); do not set it.
    });
    if (error) log('warn', 'admin_audit_write_failed', { action: entry.action, error: error.message });
  } catch (err) {
    log('warn', 'admin_audit_write_failed', { action: entry.action, error: (err as Error).message });
  }
}

// Record a blocked injection attempt at an HTTP boundary into admin_audit_log so
// the dashboard can show who's probing the door (getInjectionLog reads these back).
// Reuses the audit table (action=injection_blocked); the "actor" is the offending
// SENDER, not an admin. Non-throwing (via logAdminAction). textPreview is truncated
// — never store the full payload. NOTE: this is wired at the HTTP boundary only;
// orchestrator-internal blocks (the /chat path) are a follow-up.
export async function auditInjectionBlock(
  sb: SupabaseClient,
  input: { source: string; sender: string; reason?: string; textPreview?: string },
): Promise<void> {
  await logAdminAction(sb, {
    actor: input.sender || 'unknown',
    action: 'injection_blocked',
    entityType: 'injection',
    entityId: input.sender || 'unknown',
    payload: {
      source: input.source,
      reason: input.reason ?? null,
      textPreview: (input.textPreview ?? '').slice(0, 120),
    },
  });
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

// ── DESTRUCTIVE (memory delete / correct) — full guards ────────────────────

// Clear one profile block for the student behind a channel handle. Guards:
//   1. resolve the handle → the SAME uuid the memory path keys by (never clear the
//      wrong user's block);
//   2. validate the block name;
//   3. go through ProfileStore.saveBlock(uuid, block, '') so the KV cache is busted
//      (a raw DB write would leave a stale block in the 5-min edge cache);
//   4. snapshot the ORIGINAL value into the audit payload, so a mistaken clear is
//      recoverable from the audit trail.
export async function clearProfileBlock(
  sb: SupabaseClient,
  store: ProfileStore,
  handle: string,
  block: string,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!BLOCK_NAMES.includes(block as BlockName)) return { ok: false, error: `invalid block: ${block}` };
    const uuid = await resolveProfileKey(sb, handle);
    if (!uuid) return { ok: false, error: 'no profile for this handle' };

    // Snapshot the original before clearing (for recovery via the audit trail).
    const before = await store.loadProfile(uuid);
    const original = (before as unknown as Record<string, unknown>)[block];
    const originalStr = typeof original === 'string' ? original : '';

    await store.saveBlock(uuid, block as BlockName, ''); // overwrite + bust KV cache
    await logAdminAction(sb, {
      actor,
      action: 'clear_profile_block',
      entityType: 'profile',
      entityId: uuid,
      payload: { block, original: originalStr.slice(0, 2000), originalLen: originalStr.length },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Delete a single observation for the student behind a channel handle. Owner-scoped
// (deleteById matches user_id AND id), so an admin can't delete another student's
// row by id-guessing. Audited; a missing/not-owned id is a no-op (removed: 0).
export async function deleteObservation(
  sb: SupabaseClient,
  obsDb: ObservationDB,
  handle: string,
  observationId: number,
  actor: string,
): Promise<{ ok: boolean; removed?: number; error?: string }> {
  try {
    if (!Number.isFinite(observationId)) return { ok: false, error: 'invalid observation id' };
    const uuid = await resolveProfileKey(sb, handle);
    if (!uuid) return { ok: false, error: 'no profile for this handle' };
    const removed = await obsDb.deleteById(uuid, observationId);
    await logAdminAction(sb, {
      actor,
      action: 'delete_observation',
      entityType: 'observation',
      entityId: uuid,
      payload: { observationId, removed },
    });
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
