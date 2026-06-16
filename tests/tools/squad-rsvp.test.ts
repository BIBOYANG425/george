// tests/tools/squad-rsvp.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
beforeEach(() => { vi.resetModules() })

// A tiny chainable supabase stub: records the last update/delete payload.
function mockDb() {
  const calls: { table: string; op: string; payload?: unknown; eq: Record<string, unknown> }[] = []
  const chain = (table: string, op: string, payload?: unknown) => {
    const c: Record<string, unknown> = {}
    const rec: { table: string; op: string; payload?: unknown; eq: Record<string, unknown> } = { table, op, payload, eq: {} }
    calls.push(rec)
    c.eq = (k: string, v: unknown) => { rec.eq[k] = v; return c }
    c.select = () => c
    c.single = async () => ({ data: null, error: null })
    ;(c as { then?: unknown }).then = (res: (v: { error: null }) => void) => res({ error: null })
    return c
  }
  const from = (table: string) => ({
    update: (payload: unknown) => chain(table, 'update', payload),
    delete: () => chain(table, 'delete'),
  })
  return { client: { from }, calls }
}

describe('squad_rsvp', () => {
  it('confirm sets rsvp_status=confirmed for (post, me)', async () => {
    const { client, calls } = mockDb()
    vi.doMock('../../src/db/client.js', () => ({ supabase: client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'confirm', post_id: 'po1', student_id: 'stu-1' }))
    expect(out.ok).toBe(true)
    const upd = calls.find((c) => c.table === 'squad_members' && c.op === 'update')
    expect((upd!.payload as { rsvp_status: string }).rsvp_status).toBe('confirmed')
    expect(upd!.eq).toMatchObject({ post_id: 'po1', student_id: 'stu-1' })
  })

  it('drop deletes my member row and flags the post needs_refill', async () => {
    const { client, calls } = mockDb()
    vi.doMock('../../src/db/client.js', () => ({ supabase: client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'drop', post_id: 'po1', student_id: 'stu-1' }))
    expect(out.ok).toBe(true)
    expect(calls.some((c) => c.table === 'squad_members' && c.op === 'delete')).toBe(true)
    const flag = calls.find((c) => c.table === 'squad_posts' && c.op === 'update')
    expect((flag!.payload as { needs_refill: boolean }).needs_refill).toBe(true)
  })

  it('join delegates to join_squad_post', async () => {
    const join = vi.fn(async () => JSON.stringify({ ok: true, poster_name: 'X', contact: 'y' }))
    vi.doMock('../../src/db/client.js', () => ({ supabase: mockDb().client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    vi.doMock('../../src/tools/join-squad-post.js', () => ({ joinSquadPostHandler: join }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'join', post_id: 'po1', student_id: 'stu-1' }))
    expect(join).toHaveBeenCalledWith({ post_id: 'po1', student_id: 'stu-1' })
    expect(out.ok).toBe(true)
  })

  it('returns an error when post_id is missing for confirm/drop', async () => {
    vi.doMock('../../src/db/client.js', () => ({ supabase: mockDb().client }))
    vi.doMock('../../src/db/students.js', () => ({ resolveStudentId: vi.fn(async () => 'stu-1') }))
    const { squadRsvpHandler } = await import('../../src/tools/squad-rsvp.js')
    const out = JSON.parse(await squadRsvpHandler({ decision: 'confirm', student_id: 'stu-1' }))
    expect(out.error).toBeTruthy()
  })
})
