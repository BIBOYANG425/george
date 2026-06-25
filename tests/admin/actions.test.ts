// tests/admin/actions.test.ts
// PR-0 audit foundation: logAdminAction writes the admin_audit_log shape and is
// NON-throwing (a broken audit must never fail the underlying admin action),
// and adminActor reads the Cloudflare Access email header with a safe fallback.
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { logAdminAction, adminActor } from '../../src/admin/actions.js';

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
