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
                eq: () => ({ eq: () => updateMock() }),
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
    // Confirm the update was called (ping marked responded)
    expect(updateMock).toHaveBeenCalled()
  })

  it('23xxx Postgres error → squad_full message', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({
                error: { code: '23514', message: 'capacity_full' },
                then: (r: Function) => r({ error: { code: '23514', message: 'capacity_full' } }),
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

  it('trigger message containing "full" → squad_full message', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'squad_members') {
            return {
              insert: () => ({
                error: { code: 'P0001', message: 'squad is full' },
                then: (r: Function) => r({ error: { code: 'P0001', message: 'squad is full' } }),
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
                eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
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
