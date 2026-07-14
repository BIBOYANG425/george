import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyNoReplyGate } from '../../src/agent/noreply-gate.js'

const REAL_MASTER = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts/master.md'),
  'utf-8',
)

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

  // Guards the rebase placement of the sentinel block inside the real (restructured)
  // master.md: the gate must cleanly add/remove it without leaving artifacts.
  describe('against the real prompts/master.md', () => {
    it('the file ships the sentinels (so the gate has something to act on)', () => {
      expect(REAL_MASTER).toContain(BEGIN)
      expect(REAL_MASTER).toContain(END)
    })

    it('OFF: no NO_REPLY wording, no sentinels, no stray blank-line artifact', () => {
      delete process.env.GEORGE_NOREPLY_ENABLED
      const out = applyNoReplyGate(REAL_MASTER)
      expect(out).not.toContain('GEORGE_NOREPLY')
      expect(out).not.toContain('{{NO_REPLY}}')
      expect(out).not.toContain('Declining to reply')
      // The NO_REPLY block collapses to a single paragraph break. The adjacent
      // {{THREAD}} block is gated separately (applyThreadedRepliesGate), so this
      // gate leaves it in place — it now sits immediately after the collapse.
      expect(out).toContain("Don't tack on a help-offer.\n\n<!-- GEORGE_THREAD_BEGIN -->")
      expect(out).not.toMatch(/\n{3,}/)
    })

    it('ON: keeps the NO_REPLY bullet, drops the sentinel comments', () => {
      process.env.GEORGE_NOREPLY_ENABLED = 'true'
      const out = applyNoReplyGate(REAL_MASTER)
      expect(out).toContain('Declining to reply')
      expect(out).toContain('{{NO_REPLY}}')
      expect(out).not.toContain(BEGIN)
      expect(out).not.toContain(END)
    })
  })
})
