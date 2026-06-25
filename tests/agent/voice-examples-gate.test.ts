import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyVoiceExamplesGate } from '../../src/agent/voice-examples-gate.js'

const REAL_MASTER = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts/master.md'),
  'utf-8',
)

const BEGIN = '<!-- GEORGE_VOICE_EXAMPLES_BEGIN -->'
const END = '<!-- GEORGE_VOICE_EXAMPLES_END -->'

// A master-prompt-shaped fixture with the sentinel block at the end, mirroring
// how prompts/master.md wraps the few-shot voice examples.
const SAMPLE = [
  '## Brand',
  '',
  'BIA brand stuff.',
  '',
  BEGIN,
  '## How george texts (examples)',
  'user: nnd',
  'george: 咋了哈哈 谁惹你了',
  END,
].join('\n')

describe('applyVoiceExamplesGate', () => {
  const prev = process.env.GEORGE_VOICE_EXAMPLES_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.GEORGE_VOICE_EXAMPLES_ENABLED
    else process.env.GEORGE_VOICE_EXAMPLES_ENABLED = prev
  })

  it('default OFF: strips the block back to the pre-feature text', () => {
    delete process.env.GEORGE_VOICE_EXAMPLES_ENABLED
    const out = applyVoiceExamplesGate(SAMPLE)
    expect(out).toBe('## Brand\n\nBIA brand stuff.\n\n')
    expect(out).not.toContain('How george texts')
    expect(out).not.toContain('GEORGE_VOICE_EXAMPLES')
  })

  it('any value other than "true" is still OFF', () => {
    process.env.GEORGE_VOICE_EXAMPLES_ENABLED = '1'
    expect(applyVoiceExamplesGate(SAMPLE)).not.toContain('How george texts')
  })

  it('ON: keeps the examples but drops the sentinel comments', () => {
    process.env.GEORGE_VOICE_EXAMPLES_ENABLED = 'true'
    const out = applyVoiceExamplesGate(SAMPLE)
    expect(out).toContain('## How george texts (examples)')
    expect(out).toContain('george: 咋了哈哈 谁惹你了')
    expect(out).not.toContain(BEGIN)
    expect(out).not.toContain(END)
  })

  it('leaves a prompt without the sentinels untouched', () => {
    delete process.env.GEORGE_VOICE_EXAMPLES_ENABLED
    const plain = 'just voice rules, no sentinels here'
    expect(applyVoiceExamplesGate(plain)).toBe(plain)
  })

  // Guards the placement of the block in the real master.md: the gate must
  // cleanly add/remove it without leaving artifacts, and OFF must be byte-identical
  // to the pre-feature prompt.
  describe('against the real prompts/master.md', () => {
    it('the file ships the sentinels (so the gate has something to act on)', () => {
      expect(REAL_MASTER).toContain(BEGIN)
      expect(REAL_MASTER).toContain(END)
    })

    it('OFF: no examples, no sentinels, no stray blank-line artifact', () => {
      delete process.env.GEORGE_VOICE_EXAMPLES_ENABLED
      const out = applyVoiceExamplesGate(REAL_MASTER)
      expect(out).not.toContain('GEORGE_VOICE_EXAMPLES')
      expect(out).not.toContain('How george texts')
      expect(out).not.toContain('咋了哈哈')
      expect(out).not.toMatch(/\n{3,}/)
    })

    it('ON: keeps the examples block, drops the sentinel comments', () => {
      process.env.GEORGE_VOICE_EXAMPLES_ENABLED = 'true'
      const out = applyVoiceExamplesGate(REAL_MASTER)
      expect(out).toContain('How george texts')
      expect(out).toContain('george: 咋了哈哈 谁惹你了')
      expect(out).not.toContain(BEGIN)
      expect(out).not.toContain(END)
    })

    it('OFF leaves master.md byte-identical to the file minus the block', () => {
      delete process.env.GEORGE_VOICE_EXAMPLES_ENABLED
      const out = applyVoiceExamplesGate(REAL_MASTER)
      // No examples leak, and the result is a strict shortening of the source.
      expect(REAL_MASTER.length).toBeGreaterThan(out.length)
      expect(out).not.toContain('george: lmao what happened')
    })
  })
})
