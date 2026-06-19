import { describe, it, expect, afterEach } from 'vitest'
import {
  splitIntoMessages,
  parseControlTokens,
  stripControlTokens,
  isNoReplyEnabled,
} from '../../src/adapters/split-response.js'

describe('splitIntoMessages', () => {
  it('returns single-element array for prose without blank lines', () => {
    expect(splitIntoMessages('hello there')).toEqual(['hello there'])
  })

  it('splits on blank line into separate messages', () => {
    const input = '第一条短信\n\n第二条短信\n\n第三条'
    expect(splitIntoMessages(input)).toEqual(['第一条短信', '第二条短信', '第三条'])
  })

  it('trims whitespace on each part', () => {
    const input = '  hello  \n\n  world  '
    expect(splitIntoMessages(input)).toEqual(['hello', 'world'])
  })

  it('tolerates trailing whitespace on blank-line separator', () => {
    const input = 'first\n   \nsecond'
    expect(splitIntoMessages(input)).toEqual(['first', 'second'])
  })

  it('drops empty parts', () => {
    const input = 'a\n\n\n\n\nb'
    expect(splitIntoMessages(input)).toEqual(['a', 'b'])
  })

  it('returns empty array for empty / whitespace-only input', () => {
    expect(splitIntoMessages('')).toEqual([])
    expect(splitIntoMessages('   \n\n  ')).toEqual([])
  })

  it('keeps short CJK parts as separate messages (single-char replies are valid in WeChat)', () => {
    const input = '嗯\n\n我是说 BUAD 280 那个 Sweeney 真的别上'
    const result = splitIntoMessages(input)
    expect(result).toEqual(['嗯', '我是说 BUAD 280 那个 Sweeney 真的别上'])
  })

  it('caps at 4 parts, merging overflow into the last kept part', () => {
    const input = 'a_part_one\n\nb_part_two\n\nc_part_three\n\nd_part_four\n\ne_part_five\n\nf_part_six'
    const result = splitIntoMessages(input)
    expect(result).toHaveLength(4)
    expect(result[0]).toBe('a_part_one')
    expect(result[1]).toBe('b_part_two')
    expect(result[2]).toBe('c_part_three')
    // last part holds overflow d+e+f
    expect(result[3]).toContain('d_part_four')
    expect(result[3]).toContain('e_part_five')
    expect(result[3]).toContain('f_part_six')
  })

  it('preserves message order', () => {
    const input = '一\n\n二\n\n三'
    const result = splitIntoMessages(input)
    expect(result).toEqual(['一', '二', '三'])
  })
})

describe('parseControlTokens', () => {
  it('returns noReply:false and trimmed text for an ordinary reply', () => {
    expect(parseControlTokens('  BUAD 280 别上  ')).toEqual({
      noReply: false,
      text: 'BUAD 280 别上',
    })
  })

  it('detects a lone {{NO_REPLY}} token and yields empty text', () => {
    expect(parseControlTokens('{{NO_REPLY}}')).toEqual({ noReply: true, text: '' })
  })

  it('is case-insensitive and tolerates inner whitespace', () => {
    expect(parseControlTokens('{{ no_reply }}').noReply).toBe(true)
    expect(parseControlTokens('{{No_Reply}}').noReply).toBe(true)
  })

  it('strips the token even when the model pads it with stray words', () => {
    const r = parseControlTokens('收到啦 {{NO_REPLY}}')
    expect(r.noReply).toBe(true)
    expect(r.text).toBe('收到啦')
  })

  it('strips every occurrence when the token repeats', () => {
    const r = parseControlTokens('{{NO_REPLY}} a {{NO_REPLY}} b')
    expect(r.noReply).toBe(true)
    expect(r.text).toBe('a  b')
  })

  it('leaves a non-token reply untouched (no false positive on {{ }} prose)', () => {
    const r = parseControlTokens('用 {{name}} 占位')
    expect(r.noReply).toBe(false)
    expect(r.text).toBe('用 {{name}} 占位')
  })

  it('is safe on empty / null-ish input', () => {
    expect(parseControlTokens('')).toEqual({ noReply: false, text: '' })
    // @ts-expect-error exercising the null-guard at runtime
    expect(parseControlTokens(undefined)).toEqual({ noReply: false, text: '' })
  })

  it('is idempotent across calls (regex lastIndex is reset)', () => {
    // The /g regex must not leak state between calls.
    expect(parseControlTokens('{{NO_REPLY}}').noReply).toBe(true)
    expect(parseControlTokens('{{NO_REPLY}}').noReply).toBe(true)
    expect(parseControlTokens('hi').noReply).toBe(false)
    expect(parseControlTokens('{{NO_REPLY}}').noReply).toBe(true)
  })
})

describe('stripControlTokens', () => {
  it('removes the token from outgoing text', () => {
    expect(stripControlTokens('好的 {{NO_REPLY}}')).toBe('好的')
  })

  it('passes ordinary text through trimmed', () => {
    expect(stripControlTokens('  hi  ')).toBe('hi')
  })
})

describe('isNoReplyEnabled', () => {
  const prev = process.env.GEORGE_NOREPLY_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.GEORGE_NOREPLY_ENABLED
    else process.env.GEORGE_NOREPLY_ENABLED = prev
  })

  it('is OFF by default (unset)', () => {
    delete process.env.GEORGE_NOREPLY_ENABLED
    expect(isNoReplyEnabled()).toBe(false)
  })

  it('is OFF for any value other than the literal "true"', () => {
    process.env.GEORGE_NOREPLY_ENABLED = '1'
    expect(isNoReplyEnabled()).toBe(false)
    process.env.GEORGE_NOREPLY_ENABLED = 'yes'
    expect(isNoReplyEnabled()).toBe(false)
  })

  it('is ON only when set to "true"', () => {
    process.env.GEORGE_NOREPLY_ENABLED = 'true'
    expect(isNoReplyEnabled()).toBe(true)
  })
})
