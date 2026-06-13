// tests/tools/find-squad-posts.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

beforeEach(() => {
  vi.resetModules()
})

describe('find_squad_posts tool', () => {
  it('calls hybrid_search_posts_for_user RPC with p_student_id and returns posts', async () => {
    const rpcMock = vi.fn(async () => ({
      data: [
        { id: 'p1', content: '周五韩烤', category: '其它', max_people: 3, current_people: 1, location: 'K-town', poster_name: '小红' },
        { id: 'p2', content: '自习', category: '自习', max_people: 2, current_people: 1, location: null, poster_name: '小蓝' },
      ],
      error: null,
    }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        rpc: rpcMock,
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { findSquadPostsHandler } = await import('../../src/tools/find-squad-posts.js')
    const raw = await findSquadPostsHandler({ student_id: UUID })
    const result = JSON.parse(raw)
    expect(rpcMock).toHaveBeenCalledWith('hybrid_search_posts_for_user', {
      p_student_id: UUID,
      p_match_count: 30,
    })
    expect(Array.isArray(result.posts)).toBe(true)
    expect(result.posts.length).toBeGreaterThan(0)
  })

  it('returns {error} on RPC failure without throwing', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        rpc: vi.fn(async () => ({ data: null, error: { message: 'rpc gone wrong' } })),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { findSquadPostsHandler } = await import('../../src/tools/find-squad-posts.js')
    const raw = await findSquadPostsHandler({ student_id: UUID })
    const result = JSON.parse(raw)
    expect(result.error).toBeDefined()
  })

  it('defensive: non-uuid student_id triggers resolveStudentId', async () => {
    const resolveMock = vi.fn(async () => UUID)
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        rpc: vi.fn(async () => ({ data: [], error: null })),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: resolveMock,
    }))
    const { findSquadPostsHandler } = await import('../../src/tools/find-squad-posts.js')
    await findSquadPostsHandler({ student_id: '+16265551234' })
    expect(resolveMock).toHaveBeenCalledWith('+16265551234', 'imessage')
  })

  it('caps returned posts to a small number', async () => {
    const manyPosts = Array.from({ length: 30 }, (_, i) => ({
      id: `post-${i}`,
      content: `content ${i}`,
      category: '其它',
      max_people: 3,
      current_people: 1,
      location: null,
      poster_name: `user${i}`,
    }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        rpc: vi.fn(async () => ({ data: manyPosts, error: null })),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { findSquadPostsHandler } = await import('../../src/tools/find-squad-posts.js')
    const raw = await findSquadPostsHandler({ student_id: UUID })
    const result = JSON.parse(raw)
    // Should be capped at some reasonable number (implementation defined, ≤ 10)
    expect(result.posts.length).toBeLessThanOrEqual(10)
  })
})
