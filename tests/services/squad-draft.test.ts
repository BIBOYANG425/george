import { describe, it, expect, vi } from 'vitest'
import { draftSquadPost } from '../../src/services/squad-draft.js'

describe('draftSquadPost', () => {
  it('happy path: valid LLM response → ok draft', async () => {
    const mockLLMResponse = JSON.stringify({
      category: '自习',
      content: '周五图书馆一起自习 有人吗？Leavey 3楼',
      location: 'Leavey Library 3楼',
      max_people: 4,
      deadline: '2026-06-20T18:00:00Z',
      tags: ['自习', '图书馆', 'study'],
    })

    const complete = vi.fn(async () => mockLLMResponse)
    const result = await draftSquadPost('周五下午想找人一起去图书馆自习', { complete })

    expect(result).toMatchObject({
      ok: true,
      draft: {
        category: '自习',
        content: '周五图书馆一起自习 有人吗？Leavey 3楼',
        location: 'Leavey Library 3楼',
        max_people: 4,
        deadline: '2026-06-20T18:00:00Z',
        tags: expect.arrayContaining(['自习']),
      },
    })
  })

  it('LLM returns category=约会 → unsupported_category', async () => {
    const mockLLMResponse = JSON.stringify({
      category: '约会',
      content: '找个一起约会的',
      location: null,
      max_people: 2,
      deadline: null,
      tags: ['约会'],
    })

    const complete = vi.fn(async () => mockLLMResponse)
    const result = await draftSquadPost('想找个对象约会', { complete })

    expect(result).toEqual({ error: 'unsupported_category' })
  })

  it('LLM returns JSON with just category=约会 → unsupported_category', async () => {
    const complete = vi.fn(async () => '{"category":"约会"}')
    const result = await draftSquadPost('找女朋友', { complete })

    expect(result).toEqual({ error: 'unsupported_category' })
  })

  it('malformed / non-JSON output → draft_unavailable', async () => {
    const complete = vi.fn(async () => 'Sorry, I cannot help with that.')
    const result = await draftSquadPost('搞个活动', { complete })

    expect(result).toEqual({ error: 'draft_unavailable' })
  })

  it('LLM call throws → draft_unavailable', async () => {
    const complete = vi.fn(async () => {
      throw new Error('network error')
    })
    const result = await draftSquadPost('找人拼车', { complete })

    expect(result).toEqual({ error: 'draft_unavailable' })
  })

  it('missing required field content → draft_unavailable', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        category: '健身',
        location: 'Lyon Center',
        max_people: 3,
        deadline: null,
        tags: ['健身'],
        // content is missing
      }),
    )
    const result = await draftSquadPost('找人一起健身', { complete })

    expect(result).toEqual({ error: 'draft_unavailable' })
  })

  it('missing required field max_people → draft_unavailable', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        category: '健身',
        content: '一起健身吧',
        location: null,
        deadline: null,
        tags: ['健身'],
        // max_people is missing
      }),
    )
    const result = await draftSquadPost('找人一起健身', { complete })

    expect(result).toEqual({ error: 'draft_unavailable' })
  })

  it('unknown category from LLM → normalized to 其它', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        category: 'unknown_category',
        content: '一起活动吧',
        location: null,
        max_people: 3,
        deadline: null,
        tags: ['活动'],
      }),
    )
    const result = await draftSquadPost('找人一起搞点活动', { complete })

    expect(result).toMatchObject({
      ok: true,
      draft: { category: '其它' },
    })
  })

  it('拼车 category passes through', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        category: '拼车',
        content: '周末去SGV有人拼车吗',
        location: 'SGV',
        max_people: 4,
        deadline: null,
        tags: ['拼车', 'SGV'],
      }),
    )
    const result = await draftSquadPost('周末想去SGV吃饭 找人拼车', { complete })

    expect(result).toMatchObject({
      ok: true,
      draft: { category: '拼车' },
    })
  })
})
