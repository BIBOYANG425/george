// tests/agent/house-rules-injection.test.ts
//
// Teach george — HOUSE RULES prompt injection. Pins:
//   1. buildOverlayStack places the rules block FIRST (standing admin policy
//      outranks per-turn context).
//   2. The block reaches ALL FOUR builders (orchestrator / single / trunk /
//      agents-config sub-agents) — whichever agent crafts the reply sees it.
//   3. '' (flag off / no rules) → every builder's output is byte-identical to a
//      call without the argument (the parity-golden guarantee).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildOverlayStack,
  buildOrchestratorPrompt,
  buildSingleAgentPrompt,
  buildTrunkPrompt,
  buildAgentsConfig,
} from '../../src/agent/orchestrator.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { loadAllSkills, _resetForTest } from '../../src/skills/index.js';

const RULES = '# HOUSE RULES (standing policy set by BIA admins — follow these)\n- 别用 emoji 除非用户先用';

beforeAll(async () => {
  _resetForTest();
  await loadAllSkills(new Set(Object.keys(ALL_TOOLS)));
});

describe('buildOverlayStack — house rules slot', () => {
  it('places the rules block FIRST when present', () => {
    const stack = buildOverlayStack({ profile: null, houseRulesBlock: RULES });
    expect(stack[0]).toBe(RULES);
  });

  it('omits the slot entirely when empty (array unchanged)', () => {
    const without = buildOverlayStack({ profile: null });
    const withEmpty = buildOverlayStack({ profile: null, houseRulesBlock: '' });
    expect(withEmpty).toEqual(without);
  });
});

describe('house rules reach all four builders', () => {
  it('orchestrator / single / trunk prompts contain the block when passed', () => {
    expect(buildOrchestratorPrompt(null, null, undefined, '', false, '', null, RULES)).toContain(RULES);
    expect(buildSingleAgentPrompt(null, null, false, undefined, '', '', null, RULES)).toContain(RULES);
    expect(buildTrunkPrompt(null, null, false, undefined, '', '', null, RULES)).toContain(RULES);
  });

  it('every dispatched sub-agent prompt contains the block when passed', () => {
    const cfg = buildAgentsConfig(null, null, false, undefined, RULES);
    for (const def of Object.values(cfg)) expect(def.prompt).toContain(RULES);
  });

  it("'' → byte-identical to a call without the argument (all four builders)", () => {
    expect(buildOrchestratorPrompt(null, null, undefined, '', false, '', null, '')).toBe(
      buildOrchestratorPrompt(null, null, undefined, '', false, '', null),
    );
    expect(buildSingleAgentPrompt(null, null, false, undefined, '', '', null, '')).toBe(
      buildSingleAgentPrompt(null, null, false, undefined, '', '', null),
    );
    expect(buildTrunkPrompt(null, null, false, undefined, '', '', null, '')).toBe(
      buildTrunkPrompt(null, null, false, undefined, '', '', null),
    );
    expect(JSON.stringify(buildAgentsConfig(null, null, false, undefined, ''))).toBe(
      JSON.stringify(buildAgentsConfig(null, null, false, undefined)),
    );
  });
});
