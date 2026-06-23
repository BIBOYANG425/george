// tests/admin/user-controls.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getUserControls, setUserControls, resolveModelForUser, getModelChoices } from '../../src/admin/user-controls'

// Point the file store at a throwaway path so tests NEVER touch the live
// data/user-controls.json. The module reads GEORGE_USER_CONTROLS_PATH at call
// time and keys its cache by path, so each test's unique file stays isolated.
let storeFile: string
let counter = 0
const savedEnv: Record<string, string | undefined> = {}
const TOUCHED = ['GEORGE_USER_CONTROLS_PATH', 'ANTHROPIC_API_KEY', 'DOUBAO_API_KEY', 'DOUBAO_MODEL', 'ANTHROPIC_BASE_URL']

beforeEach(() => {
  for (const k of TOUCHED) savedEnv[k] = process.env[k]
  storeFile = path.join(os.tmpdir(), `george-uc-${process.pid}-${counter++}.json`)
  process.env.GEORGE_USER_CONTROLS_PATH = storeFile
})
afterEach(() => {
  try { fs.rmSync(storeFile, { force: true }) } catch { /* ignore */ }
  try { fs.rmSync(storeFile + '.tmp', { force: true }) } catch { /* ignore */ }
  for (const k of TOUCHED) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('UserControls — PR-1 two new dormant fields', () => {
  it('DEFAULTS include mainModel + emotionalModel as null (no undefined leak)', () => {
    const c = getUserControls('nobody')
    expect(c.modelOverride).toBeNull()
    expect(c.mainModel).toBeNull()
    expect(c.emotionalModel).toBeNull()
  })

  it('setUserControls persists mainModel + emotionalModel without touching modelOverride', () => {
    setUserControls('u1', { mainModel: 'doubao-seed-1.6', emotionalModel: 'claude-sonnet-4-6' })
    const c = getUserControls('u1')
    expect(c.mainModel).toBe('doubao-seed-1.6')
    expect(c.emotionalModel).toBe('claude-sonnet-4-6')
    expect(c.modelOverride).toBeNull()
  })

  it('partial patch leaves the other fields intact', () => {
    setUserControls('u2', { emotionalModel: 'claude-sonnet-4-6' })
    setUserControls('u2', { blocked: true })
    const c = getUserControls('u2')
    expect(c.emotionalModel).toBe('claude-sonnet-4-6')
    expect(c.blocked).toBe(true)
  })

  it('back-fills a legacy row (only modelOverride) — new fields read as null', () => {
    fs.writeFileSync(
      storeFile,
      JSON.stringify({ legacy: { modelOverride: 'claude-sonnet-4-6', dailyMessageLimit: null, blocked: false } }),
    )
    const c = getUserControls('legacy')
    expect(c.modelOverride).toBe('claude-sonnet-4-6')
    expect(c.mainModel).toBeNull()
    expect(c.emotionalModel).toBeNull()
  })
})

describe('resolveModelForUser — PR-1 inertness boundary', () => {
  it('IGNORES mainModel (still reads only modelOverride) — proves PR-1 changes no routing', () => {
    setUserControls('u3', { mainModel: 'doubao-seed-1.6' })
    expect(resolveModelForUser('u3', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('still honors the live modelOverride field', () => {
    setUserControls('u4', { modelOverride: 'doubao-seed-1.6' })
    expect(resolveModelForUser('u4', 'claude-sonnet-4-6')).toBe('doubao-seed-1.6')
  })

  it('falls back when modelOverride is an unrecognized id', () => {
    setUserControls('u5', { modelOverride: 'not-a-real-prefix' })
    expect(resolveModelForUser('u5', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})

describe('getModelChoices — tier-filtered catalog', () => {
  it('main vs emotional return env-filtered tier-correct lists, default option first', () => {
    process.env.DOUBAO_API_KEY = 'k'
    process.env.DOUBAO_MODEL = 'doubao-seed-2-0-lite-260215'
    const main = getModelChoices('main')
    const emo = getModelChoices('emotional')
    expect(main[0].id).toBe('') // inherit-default always first
    expect(emo[0].id).toBe('')
    expect(main.some((x) => x.id === 'doubao-seed-1.6')).toBe(true) // main-only
    expect(emo.some((x) => x.id === 'doubao-seed-1.6')).toBe(false)
    expect(emo.some((x) => x.id === 'doubao-seed-2-0-lite-260215')).toBe(true) // emotional-only
  })

  it('hides doubao when DOUBAO_API_KEY is unset', () => {
    delete process.env.DOUBAO_API_KEY
    expect(getModelChoices('main').some((x) => x.id === 'doubao-seed-1.6')).toBe(false)
  })
})
