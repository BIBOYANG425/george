// tests/agent/model-collapse.test.ts
//
// The MANDATORY cross-provider regression (plan §8.1). Proves the per-user MAIN-model
// COLLAPSE: when a user overrides their main model to a non-Anthropic provider (Doubao),
// EVERY dispatched sub-agent runs that same id — so the single per-query() provider env
// (set from the top-level model) is correct for the whole turn. This closes the latent
// bug where a Claude sub-agent id was sent to the Ark base URL. Covers BOTH dispatch
// paths (default multi-agent AND trunk-hybrid); single-agent is structurally immune.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  buildQueryOptions,
  buildAgentsConfig,
  buildOrchestratorPrompt,
  applyMainModelCollapse,
  type QueryOptionsInputs,
} from '../../src/agent/orchestrator.js';
import { ORCHESTRATOR_MODEL, TRUNK_MODEL } from '../../src/agent/agents.config.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { loadAllSkills, _resetForTest } from '../../src/skills/index.js';
import type { Profile } from '../../src/memory/profile.js';

beforeAll(async () => {
  _resetForTest();
  await loadAllSkills(new Set(Object.keys(ALL_TOOLS)));
});

const DOUBAO = 'doubao-seed-1.6';
const NS = (n: string) => `mcp__george__${n}`;

function baseInputs(overrides: Partial<QueryOptionsInputs> = {}): QueryOptionsInputs {
  const profile: Profile | null = null;
  const studentId = '11111111-2222-3333-4444-555555555555';
  const webAllowed = true;
  return {
    trunkHybrid: false,
    singleAgent: false,
    profile,
    studentId,
    webAllowed,
    delayContext: undefined,
    worldStateBlock: '',
    resolvedModel: ORCHESTRATOR_MODEL,
    trunkModel: TRUNK_MODEL,
    systemPrompt: buildOrchestratorPrompt(profile, studentId, undefined, ''),
    agentsConfig: buildAgentsConfig(profile, studentId, webAllowed, undefined),
    orchestratorTools: ['Task', 'Agent', NS('set_reminder'), NS('load_skill')],
    ...overrides,
  };
}

const savedDoubaoKey = process.env.DOUBAO_API_KEY;
afterEach(() => {
  if (savedDoubaoKey === undefined) delete process.env.DOUBAO_API_KEY;
  else process.env.DOUBAO_API_KEY = savedDoubaoKey;
});

describe('cross-provider MAIN-model collapse (plan §8.1 regression)', () => {
  it('default multi-agent: a Doubao main collapses ALL sub-agents onto it + provider env routes to Ark', () => {
    process.env.DOUBAO_API_KEY = 'test-key';
    const opts: any = buildQueryOptions(baseInputs({ resolvedModel: DOUBAO, mainModelOverride: DOUBAO }));
    expect(opts.model).toBe(DOUBAO);
    const models = Object.values(opts.agents).map((a: any) => a.model);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m === DOUBAO)).toBe(true); // no Claude id left to hit Ark
    // The whole-query provider env is set from the top-level model and now matches
    // every sub-agent — auth token is the Doubao key, so the routing is consistent.
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
  });

  it('trunk-hybrid: a Doubao main ALSO collapses the dispatched sub-agents (the path that hides the bug)', () => {
    process.env.DOUBAO_API_KEY = 'test-key';
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true, trunkModel: DOUBAO, mainModelOverride: DOUBAO }));
    expect(opts.model).toBe(DOUBAO);
    // find-people + whats-happening must both be Doubao, not their static FAST tier.
    expect(Object.keys(opts.agents).sort()).toEqual(['find-people', 'whats-happening']);
    expect(Object.values(opts.agents).every((a: any) => a.model === DOUBAO)).toBe(true);
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
  });

  it('NO override: the agents map is the un-collapsed config (default FAST/SMART tiering preserved)', () => {
    const inputs = baseInputs(); // mainModelOverride omitted
    const opts: any = buildQueryOptions(inputs);
    expect(opts.agents).toBe(inputs.agentsConfig); // identity — not collapsed
    expect(Object.values(opts.agents).every((a: any) => !String(a.model).startsWith('doubao'))).toBe(true);
  });

  it('single-agent path is structurally immune (no agents map to mis-route)', () => {
    const opts: any = buildQueryOptions(baseInputs({ singleAgent: true, resolvedModel: DOUBAO, mainModelOverride: DOUBAO }));
    expect('agents' in opts).toBe(false);
    expect(opts.model).toBe(DOUBAO);
  });
});

describe('applyMainModelCollapse', () => {
  const agents = {
    a: { description: '', prompt: '', tools: [], model: 'claude-sonnet-4-6' },
    b: { description: '', prompt: '', tools: [], model: 'claude-sonnet-4-6' },
  };
  it('returns the SAME object when override is null/undefined (OFF-path identity)', () => {
    expect(applyMainModelCollapse(agents, null)).toBe(agents);
    expect(applyMainModelCollapse(agents, undefined)).toBe(agents);
  });
  it('overrides every sub-agent model when an override is present, leaving the input untouched', () => {
    const out = applyMainModelCollapse(agents, DOUBAO);
    expect(out).not.toBe(agents);
    expect(Object.values(out).every((a) => a.model === DOUBAO)).toBe(true);
    expect(agents.a.model).toBe('claude-sonnet-4-6'); // input not mutated
  });
});
