// tests/admin/actions.test.ts
// PR-0 audit foundation: logAdminAction writes the admin_audit_log shape and is
// NON-throwing (a broken audit must never fail the underlying admin action),
// and adminActor reads the Cloudflare Access email header with a safe fallback.
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { logAdminAction, adminActor, flagMessage } from '../../src/admin/actions.js';

// Fake Supabase client capturing inserts; `behavior` drives the failure paths.
function fakeSb(behavior: 'ok' | 'error' | 'throw' = 'ok') {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const sb = {
    from(table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          if (behavior === 'error') return { error: { message: 'boom' } };
          if (behavior === 'throw') throw new Error('network down');
          return { error: null };
        },
      };
    },
  } as unknown as Parameters<typeof logAdminAction>[0];
  return { sb, inserts };
}

const req = (headers: Record<string, unknown>) => ({ headers } as unknown as Request);

describe('adminActor', () => {
  it('uses the Cf-Access email header when present', () => {
    expect(adminActor(req({ 'cf-access-authenticated-user-email': 'long@uscbia.com' }))).toBe('long@uscbia.com');
  });
  it('trims whitespace', () => {
    expect(adminActor(req({ 'cf-access-authenticated-user-email': '  a@b.com  ' }))).toBe('a@b.com');
  });
  it('falls back to admin-token when header absent / empty / non-string', () => {
    expect(adminActor(req({}))).toBe('admin-token');
    expect(adminActor(req({ 'cf-access-authenticated-user-email': '' }))).toBe('admin-token');
    expect(adminActor(req({ 'cf-access-authenticated-user-email': ['x@y.com'] }))).toBe('admin-token');
  });
});

describe('logAdminAction', () => {
  it('writes the admin_audit_log shape (actor→actor_email, defaults applied)', async () => {
    const { sb, inserts } = fakeSb('ok');
    await logAdminAction(sb, {
      actor: 'long@uscbia.com',
      action: 'set_controls',
      entityId: '+17474638880',
      payload: { blocked: true },
    });
    expect(inserts).toEqual([
      {
        table: 'admin_audit_log',
        row: {
          actor_email: 'long@uscbia.com',
          action: 'set_controls',
          entity_type: 'user',
          entity_id: '+17474638880',
          payload: { blocked: true },
        },
      },
    ]);
  });

  it('defaults entity_type=user and payload={} when omitted', async () => {
    const { sb, inserts } = fakeSb('ok');
    await logAdminAction(sb, { actor: 'admin-token', action: 'heartbeat_pause', entityId: 'u1' });
    expect(inserts[0].row).toMatchObject({ entity_type: 'user', payload: {} });
  });

  it('never throws when the insert returns an error (audit failure must not fail the action)', async () => {
    const { sb } = fakeSb('error');
    await expect(logAdminAction(sb, { actor: 'a', action: 'x', entityId: 'u1' })).resolves.toBeUndefined();
  });

  it('never throws when the insert call itself throws', async () => {
    const { sb } = fakeSb('throw');
    await expect(logAdminAction(sb, { actor: 'a', action: 'x', entityId: 'u1' })).resolves.toBeUndefined();
  });
});

// Richer fake for flagMessage: serves the messages snapshot read
// (.from('messages').select().eq().maybeSingle()) and captures inserts into
// message_flags + admin_audit_log.
function flagSb(opts: { message?: Record<string, unknown> | null; flagInsert?: 'ok' | 'error' | 'throw' } = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const sb = {
    from(table: string) {
      if (table === 'messages') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.message ?? null, error: null }) }) }),
        };
      }
      return {
        async insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          if (table === 'message_flags') {
            if (opts.flagInsert === 'error') return { error: { message: 'flag boom' } };
            if (opts.flagInsert === 'throw') throw new Error('network down');
          }
          return { error: null };
        },
      };
    },
  } as unknown as Parameters<typeof flagMessage>[0];
  return { sb, inserts };
}

describe('flagMessage', () => {
  const msgRow = {
    user_id: '+17474638880',
    content: 'WRIT 150 那个 prof rmp 5.0',
    agent: 'know-things',
    tool_calls: { model: 'deepseek-v4-pro', tools: [] },
    created_at: '2026-06-25T05:00:00Z',
  };

  it('writes message_flags with a server-side snapshot from the messages row + an audit row', async () => {
    const { sb, inserts } = flagSb({ message: msgRow });
    const r = await flagMessage(sb, { messageId: 'm1', kind: 'bad_turn', reason: 'invented a rating', actor: 'long@uscbia.com' });
    expect(r.ok).toBe(true);

    const flag = inserts.find((i) => i.table === 'message_flags')!.row;
    expect(flag).toMatchObject({
      message_id: 'm1',
      user_id: '+17474638880',
      kind: 'bad_turn',
      reason: 'invented a rating',
      model: 'deepseek-v4-pro', // pulled out of tool_calls.model server-side
      agent: 'know-things',
      actor: 'long@uscbia.com',
      context_snapshot: { content: 'WRIT 150 那个 prof rmp 5.0', createdAt: '2026-06-25T05:00:00Z' },
    });

    const audit = inserts.find((i) => i.table === 'admin_audit_log')!.row;
    expect(audit).toMatchObject({ actor_email: 'long@uscbia.com', action: 'flag_message', entity_type: 'message', entity_id: 'm1' });
  });

  it('records the flag with a NULL message_id (FK-safe) + attempted id in snapshot when the row is gone', async () => {
    const { sb, inserts } = flagSb({ message: null });
    const r = await flagMessage(sb, { messageId: 'gone', kind: 'bad_turn', actor: 'admin-token' });
    expect(r.ok).toBe(true);
    const flag = inserts.find((i) => i.table === 'message_flags')!.row;
    // message_id MUST be null (inserting a non-existent id would violate the FK).
    expect(flag.message_id).toBeNull();
    expect(flag).toMatchObject({
      user_id: null,
      model: null,
      agent: null,
      context_snapshot: { content: null, createdAt: null, attemptedMessageId: 'gone', snapshotMissing: 'message_gone' },
    });
  });

  it('returns ok:false and does NOT write an audit row when the flag insert errors', async () => {
    const { sb, inserts } = flagSb({ message: msgRow, flagInsert: 'error' });
    const r = await flagMessage(sb, { messageId: 'm1', kind: 'bad_turn', actor: 'a' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('flag boom');
    expect(inserts.some((i) => i.table === 'admin_audit_log')).toBe(false);
  });

  it('never throws when the insert call itself throws', async () => {
    const { sb } = flagSb({ message: msgRow, flagInsert: 'throw' });
    await expect(flagMessage(sb, { messageId: 'm1', kind: 'bad_turn', actor: 'a' })).resolves.toMatchObject({ ok: false });
  });
});
