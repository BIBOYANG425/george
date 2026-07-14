import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyThreadedRepliesGate } from '../../src/agent/threaded-replies-gate.js'
import { applyNoReplyGate } from '../../src/agent/noreply-gate.js'

const REAL_MASTER = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts/master.md'),
  'utf-8',
)

const BEGIN = '<!-- GEORGE_THREAD_BEGIN -->'
const END = '<!-- GEORGE_THREAD_END -->'

const SAMPLE = [
  'line before',
  '',
  BEGIN,
  '## Threading a reply ({{THREAD}})',
  'put exactly {{THREAD}} at the very start of your reply.',
  END,
  '',
  '## Grounding',
].join('\n')

describe('applyThreadedRepliesGate', () => {
  const prev = process.env.GEORGE_THREADED_REPLIES_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.GEORGE_THREADED_REPLIES_ENABLED
    else process.env.GEORGE_THREADED_REPLIES_ENABLED = prev
  })

  it('default OFF: strips the block back to the pre-feature text', () => {
    delete process.env.GEORGE_THREADED_REPLIES_ENABLED
    const out = applyThreadedRepliesGate(SAMPLE)
    expect(out).toBe('line before\n\n## Grounding')
    expect(out).not.toContain('{{THREAD}}')
    expect(out).not.toContain('GEORGE_THREAD')
  })

  it('any value other than "true" is still OFF', () => {
    process.env.GEORGE_THREADED_REPLIES_ENABLED = '1'
    expect(applyThreadedRepliesGate(SAMPLE)).not.toContain('{{THREAD}}')
  })

  it('ON: keeps the instruction but drops the sentinel comments', () => {
    process.env.GEORGE_THREADED_REPLIES_ENABLED = 'true'
    const out = applyThreadedRepliesGate(SAMPLE)
    expect(out).toContain('## Threading a reply ({{THREAD}})')
    expect(out).toContain('{{THREAD}} at the very start')
    expect(out).not.toContain(BEGIN)
    expect(out).not.toContain(END)
  })

  it('leaves a prompt without the sentinels untouched', () => {
    delete process.env.GEORGE_THREADED_REPLIES_ENABLED
    const plain = 'just voice rules, no sentinels here'
    expect(applyThreadedRepliesGate(plain)).toBe(plain)
  })

  describe('against the real prompts/master.md', () => {
    const prevNoReply = process.env.GEORGE_NOREPLY_ENABLED
    afterEach(() => {
      if (prevNoReply === undefined) delete process.env.GEORGE_NOREPLY_ENABLED
      else process.env.GEORGE_NOREPLY_ENABLED = prevNoReply
    })

    it('the file ships the sentinels (so the gate has something to act on)', () => {
      expect(REAL_MASTER).toContain(BEGIN)
      expect(REAL_MASTER).toContain(END)
    })

    it('OFF: no THREAD wording, no sentinels, no stray blank-line artifact', () => {
      delete process.env.GEORGE_THREADED_REPLIES_ENABLED
      const out = applyThreadedRepliesGate(REAL_MASTER)
      expect(out).not.toContain('GEORGE_THREAD')
      expect(out).not.toContain('{{THREAD}}')
      expect(out).not.toContain('Threading a reply')
      expect(out).not.toMatch(/\n{3,}/)
    })

    it('ON: keeps the THREAD bullet, drops the sentinel comments', () => {
      process.env.GEORGE_THREADED_REPLIES_ENABLED = 'true'
      const out = applyThreadedRepliesGate(REAL_MASTER)
      expect(out).toContain('Threading a reply')
      expect(out).toContain('{{THREAD}}')
      expect(out).not.toContain(BEGIN)
      expect(out).not.toContain(END)
    })

    // The load-bearing invariant: with BOTH reply-control features OFF (the
    // default), chaining both gates must reproduce the pre-feature master text
    // exactly — this is what keeps the overlay-parity goldens byte-identical.
    it('both gates OFF collapse to the original single paragraph break', () => {
      delete process.env.GEORGE_NOREPLY_ENABLED
      delete process.env.GEORGE_THREADED_REPLIES_ENABLED
      const out = applyThreadedRepliesGate(applyNoReplyGate(REAL_MASTER))
      expect(out).toContain("Don't tack on a help-offer.\n\n## Grounding and tools")
      expect(out).not.toContain('GEORGE_THREAD')
      expect(out).not.toContain('GEORGE_NOREPLY')
      expect(out).not.toMatch(/\n{3,}/)
    })
  })
})
