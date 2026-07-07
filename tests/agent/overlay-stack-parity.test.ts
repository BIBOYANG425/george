// tests/agent/overlay-stack-parity.test.ts
// GG5 item 3 pin: the four prompt builders (orchestrator / single-agent / trunk /
// agents-config) share one ordered overlay stack. This test freezes the clock and
// a representative (rich) input, then compares each builder's assembled output to a
// GOLDEN captured from the pre-refactor code. If buildOverlayStack ever changes the
// byte output of any builder, one of these equality checks fails.
//
// The golden files under tests/fixtures/overlay-parity/ were captured from the
// ORIGINAL (hand-rolled per-builder) overlay code — regenerate intentionally with
// GOLDEN_UPDATE=1 only when a prompt change is deliberate.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOrchestratorPrompt,
  buildSingleAgentPrompt,
  buildTrunkPrompt,
  buildAgentsConfig,
  buildOverlayStack,
} from '../../src/agent/orchestrator.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { loadAllSkills, _resetForTest } from '../../src/skills/index.js';
import type { Profile } from '../../src/memory/profile.js';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'overlay-parity');

// Rich, deterministic input that lights up every overlay slot:
// userProfile (filled → no nudge), relationshipNote (eval flag ON + note),
// delayContext, worldStateBlock, recallBlock, memoryTools (recall-tool flag ON +
// handle), and web guidance (webAllowed). Frozen clock pins date/mood/activity.
const PROFILE: Profile = {
  identity: 'name: Alice; year: junior',
  academic: 'major: CS',
  interests: 'hiking, food',
  relationships: 'roommate: Bob',
  state: 'stressed about finals',
  george_notes: 'keep it warm',
  relationship_note: 'Alice vents late at night; keep checking in on the thesis.',
} as unknown as Profile;
const STUDENT_ID = '11111111-2222-3333-4444-555555555555';
const HANDLE = '+15550001111';
const DELAY = '# GAP SINCE YOUR LAST REPLY\nit has been ~9h.';
const WORLD = '# WORLD INFO\nvisa season is charged right now.';
const RECALL = '## THINGS YOU REMEMBER\n- sleeps at 3am\n- celebrated a Pear offer';

function readGolden(name: string): string | null {
  const p = join(FIXTURE_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}
function writeGolden(name: string, content: string): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, name), content);
}
// Assert `actual` equals the committed golden; (re)write it when GOLDEN_UPDATE=1
// or when it does not yet exist (first capture, from the pre-refactor code).
function expectGolden(name: string, actual: string): void {
  const golden = readGolden(name);
  if (golden === null || process.env.GOLDEN_UPDATE === '1') {
    writeGolden(name, actual);
    return;
  }
  expect(actual).toBe(golden);
}

describe('overlay stack — 4-builder byte parity (golden pin)', () => {
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    _resetForTest();
    await loadAllSkills(new Set(Object.keys(ALL_TOOLS)));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T19:00:00Z'));
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    process.env.GEORGE_RECALL_TOOL_ENABLED = 'true';
    delete process.env.GEORGE_ACTIVITY_STATE_ENABLED;
    delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
  });
  afterAll(() => {
    process.env = { ...savedEnv };
  });

  it('buildOrchestratorPrompt is byte-identical to golden', () => {
    const out = buildOrchestratorPrompt(PROFILE, STUDENT_ID, DELAY, WORLD, true, RECALL, HANDLE);
    expectGolden('orchestrator.txt', out);
  });

  it('buildSingleAgentPrompt is byte-identical to golden', () => {
    const out = buildSingleAgentPrompt(PROFILE, STUDENT_ID, true, DELAY, WORLD, RECALL, HANDLE);
    expectGolden('single.txt', out);
  });

  it('buildTrunkPrompt is byte-identical to golden', () => {
    const out = buildTrunkPrompt(PROFILE, STUDENT_ID, true, DELAY, WORLD, RECALL, HANDLE);
    expectGolden('trunk.txt', out);
  });

  it('buildAgentsConfig is byte-identical to golden', () => {
    const cfg = buildAgentsConfig(PROFILE, STUDENT_ID, true, DELAY);
    // Deterministic serialization: agent name → prompt (the overlay-bearing field).
    const serialized = Object.keys(cfg)
      .sort()
      .map((name) => `===== ${name} =====\n${cfg[name].prompt}`)
      .join('\n\n');
    expectGolden('agents.txt', serialized);
  });
});

describe('buildOverlayStack — ordering + slotting contract', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('emits the flag-gated blocks in canonical order between the profile-derived ones', () => {
    const stack = buildOverlayStack({
      profile: PROFILE,
      studentId: STUDENT_ID,
      delayContext: DELAY,
      worldStateBlock: WORLD,
      relationshipNoteBlock: '# RELATIONSHIP NOTE\nx',
      recallBlock: RECALL,
      memoryToolsBlock: '# MEMORY TOOLS\ny',
    });
    const joined = stack.join('\n\n');
    // date < delay < world < userProfile < relationship < recall < studentId < memoryTools
    const idx = (s: string) => joined.indexOf(s);
    expect(idx(DELAY)).toBeGreaterThan(-1);
    expect(idx(DELAY)).toBeLessThan(idx(WORLD));
    expect(idx(WORLD)).toBeLessThan(idx('# USER PROFILE'));
    expect(idx('# USER PROFILE')).toBeLessThan(idx('# RELATIONSHIP NOTE'));
    expect(idx('# RELATIONSHIP NOTE')).toBeLessThan(idx(RECALL));
    expect(idx(RECALL)).toBeLessThan(idx('# CURRENT STUDENT'));
    expect(idx('# CURRENT STUDENT')).toBeLessThan(idx('# MEMORY TOOLS'));
  });

  it('drops omitted (empty) flag-gated blocks and the nudge when the profile is filled', () => {
    const stack = buildOverlayStack({ profile: PROFILE, studentId: STUDENT_ID });
    const joined = stack.join('\n\n');
    expect(joined).not.toContain('# WORLD INFO');
    expect(joined).not.toContain('# MEMORY TOOLS');
    expect(joined).not.toContain('# ONBOARDING'); // profile is filled
    expect(joined).toContain('# USER PROFILE');
    expect(joined).toContain('# CURRENT STUDENT');
  });

  it('adds the onboarding nudge (in place) when the profile is empty', () => {
    const stack = buildOverlayStack({ profile: null });
    expect(stack.join('\n\n')).toContain('# ONBOARDING');
  });
});
