import { describe, it, expect, afterEach } from 'vitest'
import { applyNoReplyGate } from '../../src/agent/noreply-gate.js'

const BEGIN = '<!-- GEORGE_NOREPLY_BEGIN -->'
const END = '<!-- GEORGE_NOREPLY_END -->'

// A master-prompt-shaped fixture with the sentinel block in the middle, mirroring
// how prompts/master.md wraps the {{NO_REPLY}} instruction.
const SAMPLE = [
  'line before',
  '',
  BEGIN,
  '## Declining to reply ({{NO_REPLY}})',
  'you may reply with exactly {{NO_REPLY}} and nothing else.',
  END,
  '',
  '## Anti-fabrication',
].join('\n')

describe('applyNoReplyGate', () => {
  const prev = process.env.GEORGE_NOREPLY_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.GEORGE_NOREPLY_ENABLED
    else process.env.GEORGE_NOREPLY_ENABLED = prev
  })

  it('default OFF: strips the block back to the pre-feature text', () => {
    delete process.env.GEORGE_NOREPLY_ENABLED
    const out = applyNoReplyGate(SAMPLE)
    expect(out).toBe('line before\n\n## Anti-fabrication')
    expect(out).not.toContain('{{NO_REPLY}}')
    expect(out).not.toContain('GEORGE_NOREPLY')
  })

  it('any value other than "true" is still OFF', () => {
    process.env.GEORGE_NOREPLY_ENABLED = '1'
    expect(applyNoReplyGate(SAMPLE)).not.toContain('{{NO_REPLY}}')
  })

  it('ON: keeps the instruction but drops the sentinel comments', () => {
    process.env.GEORGE_NOREPLY_ENABLED = 'true'
    const out = applyNoReplyGate(SAMPLE)
    expect(out).toContain('## Declining to reply ({{NO_REPLY}})')
    expect(out).toContain('{{NO_REPLY}} and nothing else')
    expect(out).not.toContain(BEGIN)
    expect(out).not.toContain(END)
  })

  it('leaves a prompt without the sentinels untouched', () => {
    delete process.env.GEORGE_NOREPLY_ENABLED
    const plain = 'just voice rules, no sentinels here'
    expect(applyNoReplyGate(plain)).toBe(plain)
  })
})
