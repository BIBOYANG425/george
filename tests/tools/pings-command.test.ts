// tests/tools/pings-command.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

beforeEach(() => {
  vi.resetModules()
})

describe('tryPingsCommand', () => {
  it('/pings off: upserts pings_enabled=false and returns off copy', async () => {
    const upsertMock = vi.fn(async () => ({ error: null }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          upsert: upsertMock,
        }),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { tryPingsCommand } = await import('../../src/tools/pings-command.js')
    const reply = await tryPingsCommand('+16265551234', '/pings off')
    expect(reply).not.toBeNull()
    expect(reply).toMatch(/收到|不打扰/)
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ student_id: UUID, pings_enabled: false }),
      expect.anything(),
    )
  })

  it('/pings on: upserts pings_enabled=true and returns on copy', async () => {
    const upsertMock = vi.fn(async () => ({ error: null }))
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          upsert: upsertMock,
        }),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { tryPingsCommand } = await import('../../src/tools/pings-command.js')
    const reply = await tryPingsCommand('+16265551234', '/pings on')
    expect(reply).not.toBeNull()
    expect(reply).toMatch(/包的|喊你/)
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ student_id: UUID, pings_enabled: true }),
      expect.anything(),
    )
  })

  it('/PINGS OFF (uppercase) is accepted', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          upsert: vi.fn(async () => ({ error: null })),
        }),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { tryPingsCommand } = await import('../../src/tools/pings-command.js')
    const reply = await tryPingsCommand('+16265551234', '/PINGS OFF')
    expect(reply).not.toBeNull()
  })

  it('non-pings text → null (fall through)', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: { from: () => ({}) },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { tryPingsCommand } = await import('../../src/tools/pings-command.js')
    expect(await tryPingsCommand('+16265551234', 'hi george')).toBeNull()
    expect(await tryPingsCommand('+16265551234', '/profile')).toBeNull()
    expect(await tryPingsCommand('+16265551234', '/pings')).toBeNull()
    expect(await tryPingsCommand('+16265551234', '/pings maybe')).toBeNull()
  })

  it('reply copy contains no em-dashes and ≤2 emoji', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      supabase: {
        from: () => ({
          upsert: vi.fn(async () => ({ error: null })),
        }),
      },
    }))
    vi.doMock('../../src/db/students.js', () => ({
      resolveStudentId: vi.fn(async () => UUID),
    }))
    const { tryPingsCommand } = await import('../../src/tools/pings-command.js')
    for (const cmd of ['/pings on', '/pings off']) {
      const reply = await tryPingsCommand('+16265551234', cmd)
      expect(reply).not.toMatch(/—/)
      // Count emoji (simple: match emoji code points)
      const emojiCount = (reply ?? '').match(/\p{Emoji_Presentation}/gu)?.length ?? 0
      expect(emojiCount).toBeLessThanOrEqual(2)
    }
  })
})
