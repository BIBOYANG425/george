// tests/tools/create-squad-post.test.ts
// TDD: assert spec before implementation exists.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const POST_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'

beforeEach(() => {
  vi.resetModules()
})

describe('create_squad_post tool', () => {
  it('description contains the approval-gate sentence', async () => {
    vi.doMock('../../src/db/client.js', () => ({ supabase: {} }))
    vi.doMock('../../src/services/squad-ping-deps.js', () => ({
      triggerPingFanout: vi.fn(async () => ({ sent: 0, suppressed: 0 })),
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
      getStudentById: vi.fn(async () => null),
    }))
    const { createSquadPostTool } = await import('../../src/tools/create-squad-post.js')
    // The SDK tool object exposes its description via .description
    const desc: string = (createSquadPostTool as unknown as { description: string }).description
    expect(desc).toMatch(/after the user has explicitly approved/i)
  })

  it('happy path: returns ok + post_id + reach (number), NO recipient identity fields', async () => {
    const insertMock = vi.fn(async () => ({
      data: { id: POST_ID, content: '韩烤', category: '其它', max_people: 3 },
      error: null,
    }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          insert: () => ({
            select: () => ({ single: () => insertMock() }),
          }),
        }),
        functions: {
          invoke: vi.fn(async () => ({
            data: { embeddings: [[0.1, 0.2]] },
            error: null,
          })),
        },
      },
    }))
    vi.doMock('../../src/services/squad-ping-deps.js', () => ({
      triggerPingFanout: vi.fn(async () => ({ sent: 4, suppressed: 1 })),
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
      getStudentById: vi.fn(async () => ({ id: UUID, name: '小明', poster_name: '小明' })),
    }))
    const { createSquadPostHandler } = await import('../../src/tools/create-squad-post.js')
    const raw = await createSquadPostHandler({
      student_id: UUID,
      content: '周五吃韩烤 组个局 3个人',
      category: '其它',
      max_people: 3,
    })
    const result = JSON.parse(raw)
    expect(result.ok).toBe(true)
    expect(result.post_id).toBe(POST_ID)
    expect(typeof result.reach).toBe('number')
    // Privacy: NO recipient-identifying fields
    expect(result).not.toHaveProperty('recipients')
    expect(result).not.toHaveProperty('recipient_ids')
    expect(result).not.toHaveProperty('handles')
    expect(result).not.toHaveProperty('names')
    expect(result).not.toHaveProperty('student_ids')
  })

  it('embed failure still returns ok (post not blocked)', async () => {
    const insertMock = vi.fn(async () => ({
      data: { id: POST_ID, content: '韩烤', category: '其它', max_people: 3 },
      error: null,
    }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          insert: () => ({
            select: () => ({ single: () => insertMock() }),
          }),
        }),
        functions: {
          invoke: vi.fn(async () => ({ data: null, error: { message: 'embed timeout' } })),
        },
      },
    }))
    vi.doMock('../../src/services/squad-ping-deps.js', () => ({
      triggerPingFanout: vi.fn(async () => ({ sent: 0, suppressed: 0 })),
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
      getStudentById: vi.fn(async () => null),
    }))
    const { createSquadPostHandler } = await import('../../src/tools/create-squad-post.js')
    const raw = await createSquadPostHandler({
      student_id: UUID,
      content: '组局',
      category: '其它',
      max_people: 2,
    })
    const result = JSON.parse(raw)
    expect(result.ok).toBe(true)
    expect(result.post_id).toBeDefined()
  })

  it('ping failure still returns ok (reach: null)', async () => {
    const insertMock = vi.fn(async () => ({
      data: { id: POST_ID, content: 'test', category: '其它', max_people: 2 },
      error: null,
    }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          insert: () => ({
            select: () => ({ single: () => insertMock() }),
          }),
        }),
        functions: {
          invoke: vi.fn(async () => ({ data: { embeddings: [[0.1]] }, error: null })),
        },
      },
    }))
    vi.doMock('../../src/services/squad-ping-deps.js', () => ({
      triggerPingFanout: vi.fn(async () => { throw new Error('rpc_fail') }),
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
      getStudentById: vi.fn(async () => null),
    }))
    const { createSquadPostHandler } = await import('../../src/tools/create-squad-post.js')
    const raw = await createSquadPostHandler({
      student_id: UUID,
      content: '组局',
      category: '其它',
      max_people: 2,
    })
    const result = JSON.parse(raw)
    expect(result.ok).toBe(true)
    expect(result.reach).toBeNull()
  })

  it('DB insert failure returns {error} without throwing', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          insert: () => ({
            select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'violates constraint' } }) }),
          }),
        }),
        functions: {
          invoke: vi.fn(async () => ({ data: { embeddings: [[0.1]] }, error: null })),
        },
      },
    }))
    vi.doMock('../../src/services/squad-ping-deps.js', () => ({
      triggerPingFanout: vi.fn(async () => ({ sent: 0, suppressed: 0 })),
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
      getStudentById: vi.fn(async () => null),
    }))
    const { createSquadPostHandler } = await import('../../src/tools/create-squad-post.js')
    const raw = await createSquadPostHandler({
      student_id: UUID,
      content: '组局',
      category: '其它',
      max_people: 2,
    })
    const result = JSON.parse(raw)
    expect(result.error).toBeDefined()
    expect(result.ok).toBeUndefined()
  })

  it('defensive fallback: non-uuid student_id triggers resolveStudentId', async () => {
    const resolveMock = vi.fn(async () => UUID)
    const insertMock = vi.fn(async () => ({
      data: { id: POST_ID, content: '组局', category: '其它', max_people: 2 },
      error: null,
    }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          insert: () => ({
            select: () => ({ single: () => insertMock() }),
          }),
        }),
        functions: {
          invoke: vi.fn(async () => ({ data: { embeddings: [[0.1]] }, error: null })),
        },
      },
    }))
    vi.doMock('../../src/services/squad-ping-deps.js', () => ({
      triggerPingFanout: vi.fn(async () => ({ sent: 0, suppressed: 0 })),
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: resolveMock,
      getStudentById: vi.fn(async () => null),
    }))
    const { createSquadPostHandler } = await import('../../src/tools/create-squad-post.js')
    const raw = await createSquadPostHandler({
      student_id: '+16265551234', // phone handle — not a UUID
      content: '组局',
      category: '其它',
      max_people: 2,
    })
    const result = JSON.parse(raw)
    expect(resolveMock).toHaveBeenCalledWith('+16265551234', 'imessage')
    expect(result.ok).toBe(true)
  })
})
