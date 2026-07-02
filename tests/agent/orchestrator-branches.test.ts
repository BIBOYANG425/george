// tests/agent/orchestrator-branches.test.ts
//
// Characterization + equivalence tests for buildQueryOptions' THREE agent-config
// branches (selected by GEORGE_TRUNK_HYBRID > SINGLE_AGENT > default multi-agent).
//
// Why this file exists: orchestrator.ts gates a LIVE agent's topology on two
// default-OFF env flags (GEORGE_TRUNK_HYBRID, SINGLE_AGENT). Before this file
// there was ZERO coverage of which branch is selected, of the ON-path prompt /
// tool shapes, or of the "byte-for-byte OFF" guarantee. These tests:
//   A) lock the DEFAULT (OFF) shape as the CI-protected equivalence baseline,
//      and characterize the two ON shapes + flag precedence;
//   B) assert the GE fast-path tool (ge_candidates, named by COURSE_FASTPATH
//      guidance) is actually present in the trunk's allowlist (must-fix #1);
//   C) assert the know-things domain guardrails survive in the trunk prompt
//      (must-fix #6).
//
// ENV ISOLATION (CRITICAL): these tests flip GEORGE_TRUNK_HYBRID / SINGLE_AGENT
// via process.env. A leaked SINGLE_AGENT=true or GEORGE_TRUNK_HYBRID=true would
// silently corrupt other suites. We snapshot+restore both keys in
// beforeEach/afterEach so each test starts from a clean, both-unset baseline and
// no flag state escapes this file. NOTE: buildQueryOptions itself reads its flags
// from its `inputs` argument (trunkHybrid / singleAgent booleans), NOT from
// process.env — so we drive the branch selection through inputs and ALSO model
// the real call site's `process.env.X === 'true'` precedence read explicitly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildQueryOptions,
  buildTrunkPrompt,
  buildSingleAgentPrompt,
  buildAgentsConfig,
  buildOrchestratorPrompt,
  buildOrchestratorToolNames,
  type QueryOptionsInputs,
} from '../../src/agent/orchestrator.js';
import { ORCHESTRATOR_MODEL, TRUNK_MODEL, TRUNK_TOOLS } from '../../src/agent/agents.config.js';

// ── env isolation ────────────────────────────────────────────────────────────
let savedTrunk: string | undefined;
let savedSingle: string | undefined;
beforeEach(() => {
  savedTrunk = process.env.GEORGE_TRUNK_HYBRID;
  savedSingle = process.env.SINGLE_AGENT;
  // Start every test from the canonical OFF baseline (both flags unset), so a
  // value set inside one test can never bleed into the next.
  delete process.env.GEORGE_TRUNK_HYBRID;
  delete process.env.SINGLE_AGENT;
});
afterEach(() => {
  // Restore the exact pre-test values (including "was undefined") so nothing
  // leaks out of this file into the rest of the ~1146-test suite.
  if (savedTrunk === undefined) delete process.env.GEORGE_TRUNK_HYBRID;
  else process.env.GEORGE_TRUNK_HYBRID = savedTrunk;
  if (savedSingle === undefined) delete process.env.SINGLE_AGENT;
  else process.env.SINGLE_AGENT = savedSingle;
});

// Mirror the orchestrator's real flag read (orchestrator.ts:
// `process.env.GEORGE_TRUNK_HYBRID === 'true'` / `process.env.SINGLE_AGENT === 'true'`)
// so the precedence test exercises the SAME boolean derivation the call site uses.
const trunkFlag = () => process.env.GEORGE_TRUNK_HYBRID === 'true';
const singleFlag = () => process.env.SINGLE_AGENT === 'true';

// A complete, default-OFF QueryOptionsInputs bag. Tests override the two flags
// (and nothing else) so any shape difference is attributable to the branch alone.
function mkInputs(over: Partial<QueryOptionsInputs> = {}): QueryOptionsInputs {
  return {
    trunkHybrid: false,
    singleAgent: false,
    profile: null,
    studentId: null,
    webAllowed: false,
    delayContext: undefined,
    worldStateBlock: '',
    recallBlock: '',
    handle: null,
    resolvedModel: ORCHESTRATOR_MODEL,
    trunkModel: TRUNK_MODEL,
    mainModelOverride: null,
    systemPrompt: buildOrchestratorPrompt(null, null),
    agentsConfig: buildAgentsConfig(null, null, false),
    orchestratorTools: buildOrchestratorToolNames(false),
    maxTurns: undefined,
    abortController: undefined,
    ...over,
  };
}

const ns = (name: string) => `mcp__george__${name}`;

// ─────────────────────────────────────────────────────────────────────────────
// A) BRANCH SELECTION — the core equivalence guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe('buildQueryOptions — DEFAULT multi-agent branch (OFF-path equivalence baseline)', () => {
  it('with both flags unset, returns the 3-sub-agent shape INCLUDING know-things', () => {
    expect(trunkFlag()).toBe(false);
    expect(singleFlag()).toBe(false);

    const opts = buildQueryOptions(mkInputs());
    const agentNames = Object.keys(opts.agents ?? {}).sort();
    expect(agentNames).toEqual(['find-people', 'know-things', 'whats-happening']);
    // know-things specifically must be present on the default path (this is the
    // sub-agent the trunk/single paths fold away — its presence is the OFF tell).
    expect(agentNames).toContain('know-things');
  });

  it('captures the concrete OFF-path shape as the CI-protected characterization baseline', () => {
    const opts = buildQueryOptions(mkInputs());
    // A stable, serializable subset of the default-branch options. If any of
    // these drift, the OFF path changed and this test fails loudly.
    const baseline = {
      agentNames: Object.keys(opts.agents ?? {}).sort(),
      model: opts.model,
      // DEFAULT path deliberately does NOT set `thinking` (extended thinking is
      // only disabled on the single/trunk single-loop paths). Capture that.
      thinkingType: (opts as { thinking?: { type?: string } }).thinking?.type ?? undefined,
      maxTurns: opts.maxTurns,
      allowedToolsLen: opts.allowedTools.length,
      settingSources: opts.settingSources,
      persistSession: opts.persistSession,
    };
    expect(baseline).toEqual({
      agentNames: ['find-people', 'know-things', 'whats-happening'],
      model: ORCHESTRATOR_MODEL,
      thinkingType: undefined,
      maxTurns: 12,
      allowedToolsLen: 37,
      settingSources: [],
      persistSession: false,
    });
  });

  it('default allowedTools advertise Task/Agent dispatch + the full namespaced toolset', () => {
    const opts = buildQueryOptions(mkInputs());
    expect(opts.allowedTools).toContain('Task');
    expect(opts.allowedTools).toContain('Agent');
    // The default path's allowedTools is Task/Agent/WebSearch + ALL_TOOLS, so a
    // known tool from each domain is present.
    expect(opts.allowedTools).toContain(ns('campus_knowledge'));
    expect(opts.allowedTools).toContain(ns('create_squad_post'));
    expect(opts.allowedTools).toContain(ns('search_events'));
    // CRITICAL sandbox invariant preserved on the OFF path.
    expect(opts.settingSources).toEqual([]);
    expect(opts.persistSession).toBe(false);
  });
});

describe('buildQueryOptions — SINGLE_AGENT branch', () => {
  it('with SINGLE_AGENT=true (trunk unset): no sub-agents, thinking disabled, all domains folded in', () => {
    process.env.SINGLE_AGENT = 'true';
    delete process.env.GEORGE_TRUNK_HYBRID;
    expect(singleFlag()).toBe(true);
    expect(trunkFlag()).toBe(false);

    // Branch selection is driven by the inputs booleans (which the call site
    // derives from these same env flags).
    const opts = buildQueryOptions(mkInputs({ singleAgent: singleFlag(), trunkHybrid: trunkFlag() }));

    // No sub-agents map on the single-agent path (one agent does everything).
    expect(opts.agents).toBeUndefined();
    // Extended thinking disabled (single agentic loop — matches the trunk path).
    expect(opts.thinking).toEqual({ type: 'disabled' });
    // The one agent's allowedTools is the UNIFIED set (all three domains folded
    // in): a known know-things tool AND a known squad tool are both present.
    expect(opts.allowedTools).toContain(ns('campus_knowledge')); // know-things domain
    expect(opts.allowedTools).toContain(ns('create_squad_post')); // find-people / squad domain
    expect(opts.allowedTools).toContain(ns('search_events')); // whats-happening domain
    // Sandbox invariant still held on this path.
    expect(opts.settingSources).toEqual([]);
  });

  it('runs on the SMART tier (trunkModel), not the fast/orchestrator tier', () => {
    process.env.SINGLE_AGENT = 'true';
    delete process.env.GEORGE_TRUNK_HYBRID;
    // The single agent owns know-things directly — same tier rationale as the
    // trunk. Under split tiers (FAST=kimi-k2, SMART=sonnet) the fast tier here
    // would downgrade the high-stakes domain.
    const opts = buildQueryOptions(
      mkInputs({ singleAgent: true, trunkHybrid: false, trunkModel: 'smart-sentinel', resolvedModel: 'fast-sentinel' }),
    );
    expect(opts.model).toBe('smart-sentinel');
  });
});

describe('buildQueryOptions — GEORGE_TRUNK_HYBRID branch', () => {
  it('with GEORGE_TRUNK_HYBRID=true: exactly find-people + whats-happening (NOT know-things), thinking disabled', () => {
    process.env.GEORGE_TRUNK_HYBRID = 'true';
    delete process.env.SINGLE_AGENT;
    expect(trunkFlag()).toBe(true);

    const opts = buildQueryOptions(mkInputs({ trunkHybrid: trunkFlag(), singleAgent: singleFlag() }));

    const agentNames = Object.keys(opts.agents ?? {}).sort();
    expect(agentNames).toEqual(['find-people', 'whats-happening']);
    // know-things is NOT a dispatched sub-agent on the trunk path — the trunk
    // answers that domain directly with its own tools.
    expect(agentNames).not.toContain('know-things');
    // Single-loop → extended thinking disabled (matches single-agent path).
    expect(opts.thinking).toEqual({ type: 'disabled' });
    // The trunk holds the know-things toolset directly (no know-things dispatch).
    expect(opts.allowedTools).toContain(ns('campus_knowledge'));
    expect(opts.allowedTools).toContain(ns('get_rmp_ratings'));
    // It does NOT hold the squad tools (those stay behind the find-people dispatch).
    expect(opts.allowedTools).not.toContain(ns('create_squad_post'));
    // Sandbox invariant preserved.
    expect(opts.settingSources).toEqual([]);
  });
});

describe('buildQueryOptions — flag precedence (TRUNK wins over SINGLE)', () => {
  it('with BOTH flags true: trunk path is selected (2 sub-agents), NOT the single-agent path', () => {
    process.env.GEORGE_TRUNK_HYBRID = 'true';
    process.env.SINGLE_AGENT = 'true';
    expect(trunkFlag()).toBe(true);
    expect(singleFlag()).toBe(true);

    // Both booleans true — buildQueryOptions must check trunkHybrid FIRST.
    const opts = buildQueryOptions(mkInputs({ trunkHybrid: trunkFlag(), singleAgent: singleFlag() }));

    // Trunk shape (2 dispatched sub-agents), NOT the single-agent shape (no agents map).
    const agentNames = Object.keys(opts.agents ?? {}).sort();
    expect(agentNames).toEqual(['find-people', 'whats-happening']);
    expect(opts.agents).toBeDefined();
    // Trunk-specific tell: ge_candidates present (the single path also has it, but
    // the agents map distinguishes them — agents map present + 2 agents == trunk).
    expect(opts.maxTurns).toBe(10); // trunk default maxTurns (single is 8)
  });
});

describe('env isolation — flags do not leak out of this file', () => {
  it('beforeEach resets both flags to unset, so each test starts byte-identical to OFF', () => {
    // This runs after the precedence test set BOTH flags; beforeEach must have
    // cleared them again. If isolation were broken this would be 'true'.
    expect(process.env.GEORGE_TRUNK_HYBRID).toBeUndefined();
    expect(process.env.SINGLE_AGENT).toBeUndefined();
    // And the default branch is selected with no inputs overrides.
    const opts = buildQueryOptions(mkInputs());
    expect(Object.keys(opts.agents ?? {}).sort()).toEqual([
      'find-people',
      'know-things',
      'whats-happening',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) must-fix #1 — GE fast-path tool presence in the trunk allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe('must-fix #1 — ge_candidates (named by COURSE_FASTPATH guidance) is in the trunk allowlist', () => {
  it('TRUNK_TOOLS includes ge_candidates', () => {
    // The trunk prompt's COURSE_FASTPATH guidance instructs the model to "call
    // ge_candidates ONCE". ge_candidates lives only in ALL_TOOLS (not in
    // SUB_AGENTS['know-things'].tools), so it must be added explicitly to
    // TRUNK_TOOLS or the trunk would be told to call a tool it cannot invoke.
    expect((TRUNK_TOOLS as readonly string[]).includes('ge_candidates')).toBe(true);
  });

  it('the trunk branch allowedTools contains the namespaced ge_candidates', () => {
    process.env.GEORGE_TRUNK_HYBRID = 'true';
    const opts = buildQueryOptions(mkInputs({ trunkHybrid: true }));
    expect(opts.allowedTools).toContain(ns('ge_candidates'));
  });

  it('the trunk prompt actually references ge_candidates (guidance + tool agree)', () => {
    const tp = buildTrunkPrompt(null, null);
    expect(tp).toContain('ge_candidates');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) must-fix #6 — know-things domain guardrails survive in the trunk prompt
// ─────────────────────────────────────────────────────────────────────────────

describe('must-fix #6 — know-things domain rules survive verbatim in the trunk prompt', () => {
  const trunkPrompt = () => buildTrunkPrompt(null, null);

  it('keeps the WRIT 150 5.0-tier RMP rule (prefer 4.8+, fall back to 4.5+)', () => {
    const tp = trunkPrompt();
    expect(tp).toMatch(/WRIT 150/);
    // The "5.0" framing in practice = the elevated WRIT-150 threshold (4.8+/4.5+).
    expect(tp).toMatch(/4\.8\+/);
    expect(tp).toMatch(/4\.5\+/);
  });

  it('keeps the default RMP threshold (above 4.0 for most courses)', () => {
    expect(trunkPrompt()).toMatch(/Default to RMP ratings above 4\.0/);
  });

  it('keeps the "never invent housing prices" anti-fabrication rule', () => {
    const tp = trunkPrompt();
    expect(tp).toMatch(/NEVER invent/);
    expect(tp).toMatch(/Housing prices, sublet availability/);
  });

  it('keeps the DPS-zone safety framing (trunk holds dps_zone_check + answers walkability directly)', () => {
    const tp = trunkPrompt();
    // The trunk's self-contained routing prompt names DPS-zone walkability/safety
    // as a direct-answer domain and points at dps_zone_check + find_places.
    expect(tp).toMatch(/DPS-zone/);
    expect(tp).toMatch(/dps_zone_check/);
  });

  it('the inlined know-things rules are NOT silently dropped (trunk prompt is the union, not a subset)', () => {
    const tp = trunkPrompt();
    const kt = buildSingleAgentPrompt(null, null); // single agent inlines the SAME know-things block
    // Spot-check that representative know-things lines present in the unified
    // single-agent prompt are also present in the trunk prompt.
    for (const needle of ['Default to RMP ratings above 4.0', 'WRIT 150', 'Housing prices, sublet availability']) {
      expect(kt).toContain(needle); // sanity: the line exists in the shared source
      expect(tp).toContain(needle); // and survives into the trunk prompt
    }
  });
});
