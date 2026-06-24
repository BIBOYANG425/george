// The three-state user-row save in runOrchestratorText (the burst guard's
// load-bearing correctness path). Driven through the REAL handleText →
// runOrchestratorText, with the onboarding/command/injection side-deps mocked to
// no-ops so a plain message flows straight to the orchestrator. runOrchestrator
// is mocked so we can drive each outcome: completed / aborted / errored.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ run: null as null | ((a: unknown) => AsyncGenerator<unknown>) }))

vi.mock('../../src/agent/orchestrator.js', () => ({ runOrchestrator: (a: unknown) => h.run!(a) }))
vi.mock('../../src/memory/capture.js', () => ({ captureFactsFromTurn: vi.fn() }))
vi.mock('../../src/agent/evaluators/registry.js', () => ({ TURN_EVALUATORS: [], dispatchEvaluators: vi.fn() }))
vi.mock('../../src/security/injection-filter.js', () => ({ checkInjection: () => ({ blocked: false }), INJECTION_REJECTIONS: {} }))
vi.mock('../../src/onboarding/handshake.js', () => ({
  extractCodeFromStartMessage: () => null, runHandshake: vi.fn(async () => false),
  resendOnboardLink: vi.fn(async () => {}), shouldRelink: () => false,
}))
vi.mock('../../src/onboarding/pending-users.js', () => ({
  lookupByImessageHandle: vi.fn(async () => null), lookupByCode: vi.fn(async () => null),
  linkImessageHandle: vi.fn(async () => {}), markGreeted: vi.fn(async () => {}), markReminded: vi.fn(async () => {}),
}))
vi.mock('../../src/tools/pings-command.js', () => ({ tryPingsCommand: vi.fn(async () => null) }))
vi.mock('../../src/agent/user-command-router.js', () => ({ tryHandleUserCommand: vi.fn(async () => null) }))

import { buildSpectrumHandlers } from '../../src/adapters/spectrum.js'
import type { ReplyHandle } from '../../src/adapters/spectrum-client.js'

const reply: ReplyHandle = {
  sendText: async () => {}, sendAttachment: async () => {}, startTyping: async () => {}, stopTyping: async () => {},
}

function fakeStore() {
  const roles: string[] = []
  const store = {
    load: async () => null,
    save: async (_id: string, s: { messages: Array<{ role: string }> }) => { roles.push(s.messages[0].role) },
    countUserMessages: async () => 0,
  }
  return { store, roles }
}

const ENV = 'SPECTRUM_BURST_GUARD_ENABLED'
let savedEnv: string | undefined

describe('runOrchestratorText — three-state user-row save', () => {
  beforeEach(() => { savedEnv = process.env[ENV] })
  afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv })

  async function run(flag: 'on' | 'off', text: string, ac?: AbortController) {
    if (flag === 'on') process.env[ENV] = 'true'
    else delete process.env[ENV]
    const { store, roles } = fakeStore()
    const handlers = buildSpectrumHandlers({ sessionStore: store as never })
    const out = await handlers.handleText('+15550001111', text, reply, ac)
    return { out, roles }
  }

  it('ON + completed → saves user + assistant, once each', async () => {
    h.run = async function* () { yield { type: 'result', result: 'hi there' } }
    const { out, roles } = await run('on', 'hello')
    expect(out).toBe('hi there')
    expect(roles).toEqual(['user', 'assistant'])
  })

  it('ON + aborted (superseded) → saves NOTHING (refold carries the text; no double-save / count inflation)', async () => {
    const ac = new AbortController()
    h.run = async function* () { ac.abort(); throw new Error('aborted'); yield {} } // eslint-disable-line no-unreachable
    const { out, roles } = await run('on', 'm1', ac)
    expect(out).toBeNull() // empty reply → handleText sends nothing
    expect(roles).toEqual([])
  })

  it('ON + genuine error (not aborted) → STILL saves the user row [IRON regression: survives-failure guarantee]', async () => {
    h.run = async function* () { throw new Error('orchestrator blew up'); yield {} } // eslint-disable-line no-unreachable
    const { out, roles } = await run('on', 'important question')
    expect(out).toBeNull() // empty reply → handleText sends nothing
    expect(roles).toEqual(['user']) // user preserved, no assistant
  })

  it('OFF → byte-identical: user saved before run, then assistant', async () => {
    h.run = async function* () { yield { type: 'result', result: 'pong' } }
    const { out, roles } = await run('off', 'hey')
    expect(out).toBe('pong')
    expect(roles).toEqual(['user', 'assistant'])
  })

  it('OFF + error → rethrows (today’s propagate), user already saved before run', async () => {
    h.run = async function* () { throw new Error('boom'); yield {} } // eslint-disable-line no-unreachable
    const { store, roles } = fakeStore()
    delete process.env[ENV]
    const handlers = buildSpectrumHandlers({ sessionStore: store as never })
    await expect(handlers.handleText('+15550001111', 'q', reply)).rejects.toThrow('boom')
    expect(roles).toEqual(['user'])
  })
})
