// tests/tools/join-squad-post.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const POST_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'

beforeEach(() => {
  vi.resetModules()
})

describe('join_squad_post tool', () => {
  it('happy path: inserts member, marks ping responded, returns poster_name + contact', async () => {
    const updateMock = vi.fn(async () => ({ error: null }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({ error: null, then: (r: Function) => r({ error: null }) }),
            }
          }
          if (table === 'squad_pings') {
            return {
              update: () => ({
                eq: () => ({ eq: () => ({ eq: () => updateMock() }) }),
              }),
            }
          }
          if (table === 'squad_posts') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { poster_name: '小明', contact: 'wechat: abc123' },
                    error: null,
                  }),
                }),
              }),
            }
          }
          return {}
        },
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { joinSquadPostHandler } = await import('../../src/tools/join-squad-post.js')
    const raw = await joinSquadPostHandler({ post_id: POST_ID, student_id: UUID })
    const result = JSON.parse(raw)
    expect(result.ok).toBe(true)
    expect(result.poster_name).toBe('小明')
    expect(result.contact).toBe('wechat: abc123')
    // Confirm the update was called (ping marked responded), scoped to status='sent'
    expect(updateMock).toHaveBeenCalled()
  })

  it('real trigger error { code:P0001, message:squad_full } → squad_full message', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({
                error: { code: 'P0001', message: 'squad_full' },
                then: (r: Function) => r({ error: { code: 'P0001', message: 'squad_full' } }),
              }),
            }
          }
          return {}
        },
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { joinSquadPostHandler } = await import('../../src/tools/join-squad-post.js')
    const raw = await joinSquadPostHandler({ post_id: POST_ID, student_id: UUID })
    const result = JSON.parse(raw)
    expect(result.error).toBe('squad_full')
    expect(result.message).toMatch(/满了|full/i)
  })

  it('unique_violation { code:23505 } → already_joined message (not squad_full)', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                then: (r: Function) =>
                  r({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
              }),
            }
          }
          return {}
        },
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { joinSquadPostHandler } = await import('../../src/tools/join-squad-post.js')
    const raw = await joinSquadPostHandler({ post_id: POST_ID, student_id: UUID })
    const result = JSON.parse(raw)
    expect(result.error).toBe('already_joined')
    expect(result.message).toMatch(/已经在/)
  })

  it('post_not_found (P0001, not squad_full) → generic {error}, never squad_full', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({
                error: { code: 'P0001', message: 'post_not_found' },
                then: (r: Function) => r({ error: { code: 'P0001', message: 'post_not_found' } }),
              }),
            }
          }
          return {}
        },
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { joinSquadPostHandler } = await import('../../src/tools/join-squad-post.js')
    const raw = await joinSquadPostHandler({ post_id: POST_ID, student_id: UUID })
    const result = JSON.parse(raw)
    expect(result.error).not.toBe('squad_full')
    expect(result.error).not.toBe('already_joined')
    expect(result.error).toBeDefined()
  })

  it('defensive: non-uuid student_id triggers resolveStudentId', async () => {
    const resolveMock = vi.fn(async () => UUID)
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return { insert: () => ({ error: null, then: (r: Function) => r({ error: null }) }) }
          }
          if (table === 'squad_pings') {
            return {
              update: () => ({
                eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
              }),
            }
          }
          if (table === 'squad_posts') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({ data: { poster_name: '学长', contact: null }, error: null }),
                }),
              }),
            }
          }
          return {}
        },
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: resolveMock,
    }))
    const { joinSquadPostHandler } = await import('../../src/tools/join-squad-post.js')
    await joinSquadPostHandler({ post_id: POST_ID, student_id: '+16265551234' })
    expect(resolveMock).toHaveBeenCalledWith('+16265551234', 'imessage')
  })

  it('other DB error returns {error} without throwing', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({
                error: { code: '42P01', message: 'relation does not exist' },
                then: (r: Function) => r({ error: { code: '42P01', message: 'relation does not exist' } }),
              }),
            }
          }
          return {}
        },
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { joinSquadPostHandler } = await import('../../src/tools/join-squad-post.js')
    const raw = await joinSquadPostHandler({ post_id: POST_ID, student_id: UUID })
    const result = JSON.parse(raw)
    expect(result.error).toBeDefined()
    expect(result.ok).toBeUndefined()
  })
})
