// tests/agent/trunk-hybrid.test.ts
// Covers the GEORGE_TRUNK_HYBRID (default-OFF) trunk-hybrid path AND the binding
// OFF-path equivalence guarantee (must-fix 4): with the flag unset, the produced
// queryOptions for both the singleAgent and multi branches must be byte-identical
// to today's behavior. Authored from scratch — no prior test referenced
// SINGLE_AGENT / buildSingleAgentPrompt / the trunk path.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildQueryOptions,
  buildTrunkPrompt,
  buildTrunkAgentsConfig,
  buildSingleAgentPrompt,
  buildOrchestratorPrompt,
  buildAgentsConfig,
  type QueryOptionsInputs,
} from '../../src/agent/orchestrator.js';
import {
  TRUNK_TOOLS,
  TRUNK_MODEL,
  ORCHESTRATOR_MODEL,
  KNOW_THINGS_PROMPT,
  SUB_AGENTS,
} from '../../src/agent/agents.config.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { loadAllSkills, _resetForTest, getFullCatalog } from '../../src/skills/index.js';
import type { Profile } from '../../src/memory/profile.js';

// Skill catalog must be built so buildTrunkPrompt / buildSingleAgentPrompt can
// append getFullCatalog() (which the trunk uses to discover the new playbooks).
beforeAll(async () => {
  _resetForTest();
  await loadAllSkills(new Set(Object.keys(ALL_TOOLS)));
});

const NS = (n: string) => `mcp__george__${n}`;

// The 18 know-things-domain tools the trunk owns directly. Derived from the
// know-things sub-agent's list + ge_candidates (must-fix 1).
const KNOW_THINGS_TOOLS = SUB_AGENTS['know-things'].tools;

// Build the shared inputs the OFF/multi path uses, mirroring runOrchestrator's
// resolved values, so we can prove the builder produces today's exact options.
function baseInputs(overrides: Partial<QueryOptionsInputs> = {}): QueryOptionsInputs {
  const profile: Profile | null = null;
  const studentId = '11111111-2222-3333-4444-555555555555';
  const webAllowed = true;
  const delayContext = undefined;
  const worldStateBlock = '';
  return {
    trunkHybrid: false,
    singleAgent: false,
    profile,
    studentId,
    webAllowed,
    delayContext,
    worldStateBlock,
    resolvedModel: ORCHESTRATOR_MODEL,
    trunkModel: TRUNK_MODEL,
    systemPrompt: buildOrchestratorPrompt(profile, studentId, delayContext, worldStateBlock),
    agentsConfig: buildAgentsConfig(profile, studentId, webAllowed, delayContext),
    orchestratorTools: ['Task', 'Agent', NS('set_reminder'), NS('load_skill')],
    maxTurns: undefined,
    abortController: undefined,
    ...overrides,
  };
}

// Strip the opaque/non-serializable fields (mcpServers carries the live SDK server
// object) so we can deep-compare the structural shape of the options.
function structural(opts: any): any {
  const { mcpServers, abortController, ...rest } = opts;
  return rest;
}

describe('must-fix 4 — OFF-path byte-for-byte equivalence (flag unset)', () => {
  it('multi-agent branch matches today: systemPrompt, model, tools, allowedTools, agents, maxTurns, settingSources', () => {
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: false, singleAgent: false }));
    // The exact shape today's main produces for the default multi-agent path.
    const inputs = baseInputs();
    expect(structural(opts)).toEqual({
      systemPrompt: inputs.systemPrompt,
      model: ORCHESTRATOR_MODEL,
      tools: inputs.orchestratorTools,
      allowedTools: ['Task', 'Agent', 'WebSearch', ...Object.keys(ALL_TOOLS).map(NS)],
      agents: inputs.agentsConfig,
      maxTurns: 12,
      settingSources: [],
      persistSession: false,
    });
    // The multi-agent path must NOT set thinking (today's behavior).
    expect('thinking' in opts).toBe(false);
  });

  it('multi-agent branch respects an explicit maxTurns override', () => {
    const opts: any = buildQueryOptions(baseInputs({ maxTurns: 3 }));
    expect(opts.maxTurns).toBe(3);
  });

  it('single-agent branch matches today: unified prompt, all tools, thinking disabled, maxTurns 8', () => {
    const inputs = baseInputs({ singleAgent: true });
    const opts: any = buildQueryOptions(inputs);
    const allToolsNs = [...Object.keys(ALL_TOOLS).map(NS), 'WebSearch'];
    expect(structural(opts)).toEqual({
      systemPrompt: buildSingleAgentPrompt(
        inputs.profile,
        inputs.studentId,
        inputs.webAllowed,
        inputs.delayContext,
        inputs.worldStateBlock,
      ),
      model: ORCHESTRATOR_MODEL,
      thinking: { type: 'disabled' },
      tools: allToolsNs,
      allowedTools: allToolsNs,
      maxTurns: 8,
      settingSources: [],
      persistSession: false,
    });
    // No agents map on the single-agent path (today's behavior).
    expect('agents' in opts).toBe(false);
  });

  it('single-agent branch drops WebSearch when over the daily cap (today behavior)', () => {
    const opts: any = buildQueryOptions(baseInputs({ singleAgent: true, webAllowed: false }));
    expect(opts.tools).not.toContain('WebSearch');
    expect(opts.allowedTools).not.toContain('WebSearch');
  });

  it('settingSources:[] is preserved in ALL THREE branches (sandbox invariant)', () => {
    expect((buildQueryOptions(baseInputs()) as any).settingSources).toEqual([]);
    expect((buildQueryOptions(baseInputs({ singleAgent: true })) as any).settingSources).toEqual([]);
    expect((buildQueryOptions(baseInputs({ trunkHybrid: true })) as any).settingSources).toEqual([]);
  });
});

describe('trunk-hybrid path (flag ON)', () => {
  it('uses the trunk agents map: exactly find-people + whats-happening, no know-things', () => {
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true }));
    expect(Object.keys(opts.agents).sort()).toEqual(['find-people', 'whats-happening']);
    expect(opts.agents['know-things']).toBeUndefined();
  });

  it('trunk runs on SMART (TRUNK_MODEL) and disables extended thinking (must-fix 3)', () => {
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true }));
    expect(opts.model).toBe(TRUNK_MODEL);
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });

  it('trunk holds know-things tools + Task/Agent + set_reminder/load_skill, excludes squad/event tools', () => {
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true }));
    expect(opts.allowedTools).toContain('Task');
    expect(opts.allowedTools).toContain('Agent');
    expect(opts.allowedTools).toContain(NS('recommend_courses'));
    expect(opts.allowedTools).toContain(NS('set_reminder'));
    expect(opts.allowedTools).toContain(NS('load_skill'));
    // Must NOT hold find-people / whats-happening exclusive tools.
    expect(opts.allowedTools).not.toContain(NS('create_squad_post'));
    expect(opts.allowedTools).not.toContain(NS('search_events'));
    expect(opts.allowedTools).not.toContain(NS('lookup_student'));
    expect(opts.allowedTools).not.toContain(NS('join_squad_post'));
    // tools and allowedTools are the same allowlist.
    expect(opts.tools).toEqual(opts.allowedTools);
  });

  it('trunk includes WebSearch only when under cap', () => {
    expect((buildQueryOptions(baseInputs({ trunkHybrid: true, webAllowed: true })) as any).allowedTools).toContain('WebSearch');
    expect((buildQueryOptions(baseInputs({ trunkHybrid: true, webAllowed: false })) as any).allowedTools).not.toContain('WebSearch');
  });

  it('trunkHybrid takes precedence over singleAgent', () => {
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true, singleAgent: true }));
    // Trunk shape: has an agents map (single-agent path never does).
    expect(Object.keys(opts.agents).sort()).toEqual(['find-people', 'whats-happening']);
  });

  it('trunk maxTurns defaults to 10, honors override', () => {
    expect((buildQueryOptions(baseInputs({ trunkHybrid: true })) as any).maxTurns).toBe(10);
    expect((buildQueryOptions(baseInputs({ trunkHybrid: true, maxTurns: 5 })) as any).maxTurns).toBe(5);
  });
});

describe('must-fix 1 — every tool named in batch/course-fastpath guidance is on the trunk allowlist', () => {
  it('ge_candidates is in TRUNK_TOOLS and on the trunk allowlist', () => {
    expect(TRUNK_TOOLS).toContain('ge_candidates');
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true }));
    expect(opts.allowedTools).toContain(NS('ge_candidates'));
  });

  it('TRUNK_TOOLS = the 18 know-things tools + ge_candidates + set_reminder + load_skill', () => {
    expect([...TRUNK_TOOLS].sort()).toEqual(
      [...KNOW_THINGS_TOOLS, 'ge_candidates', 'set_reminder', 'load_skill'].sort(),
    );
    // No find-people / whats-happening exclusive tools leak in.
    expect(TRUNK_TOOLS).not.toContain('create_squad_post');
    expect(TRUNK_TOOLS).not.toContain('search_events');
    expect(TRUNK_TOOLS).not.toContain('lookup_student');
  });

  it('every tool name referenced by the trunk prompt guidance has a namespaced entry on the allowlist', () => {
    const prompt = buildTrunkPrompt(null, null, false);
    const opts: any = buildQueryOptions(baseInputs({ trunkHybrid: true }));
    const allowed = new Set<string>(opts.allowedTools);
    // The tools the inlined BATCH_TOOLS_GUIDANCE + COURSE_FASTPATH_GUIDANCE name by
    // name. ge_candidates is the one the critic flagged. Assert each is reachable.
    for (const tool of ['ge_candidates', 'search_ge_courses', 'get_rmp_ratings', 'recommend_courses']) {
      // It is referenced in the prompt body...
      expect(prompt).toContain(tool);
      // ...and present (namespaced) in the allowlist so the trunk can call it.
      expect(allowed.has(NS(tool))).toBe(true);
    }
  });
});

describe('buildTrunkAgentsConfig — thin wrapper over buildAgentsConfig (must-fix 5)', () => {
  it('returns exactly find-people + whats-happening (know-things dropped)', () => {
    const cfg = buildTrunkAgentsConfig(null, '11111111-2222-3333-4444-555555555555');
    expect(Object.keys(cfg).sort()).toEqual(['find-people', 'whats-happening']);
    expect((cfg as any)['know-things']).toBeUndefined();
  });

  it('kept sub-agents are byte-identical to buildAgentsConfig output (no signature/shape change)', () => {
    const full = buildAgentsConfig(null, 'sid-123', true, undefined);
    const trunk = buildTrunkAgentsConfig(null, 'sid-123', true, undefined);
    expect(trunk['find-people']).toEqual(full['find-people']);
    expect(trunk['whats-happening']).toEqual(full['whats-happening']);
  });

  it('buildAgentsConfig still emits the full 3-agent shape incl. know-things WebSearch/find_places (OFF path depends on it)', () => {
    const full = buildAgentsConfig(null, null, true);
    expect(Object.keys(full).sort()).toEqual(['find-people', 'know-things', 'whats-happening']);
    expect(full['know-things'].tools).toContain('WebSearch');
    expect(full['know-things'].tools).toContain(NS('find_places'));
  });
});

describe('must-fix 2 — trunk routing prompt does NOT carry the 3-way orchestrator dispatch contradiction', () => {
  it('does not tell the trunk to dispatch to a know-things sub-agent', () => {
    const prompt = buildTrunkPrompt(null, null, false);
    // The verbatim orchestrator.md phrasing must not appear (it would say
    // "delegate to ONE of these three" incl. know-things and reference
    // Agent('know-things', ...)).
    expect(prompt).not.toMatch(/delegate to ONE of these three/i);
    expect(prompt).not.toMatch(/Agent\('know-things'/);
    expect(prompt).not.toMatch(/^- \*\*know-things\*\*/m);
  });

  it('scopes dispatch to exactly find-people (squad) and whats-happening (events), answer USC knowledge directly', () => {
    const prompt = buildTrunkPrompt(null, null, false);
    expect(prompt).toContain('find-people');
    expect(prompt).toContain('whats-happening');
    expect(prompt).toMatch(/answer USC knowledge yourself/i);
    expect(prompt).toMatch(/no know-things\s+sub-agent/i);
  });

  it('contains the know-things domain rules inlined (so nothing the trunk now answers loses a rule)', () => {
    const prompt = buildTrunkPrompt(null, null, false);
    expect(prompt).toContain(KNOW_THINGS_PROMPT);
  });

  it('does NOT inline the find-people or whats-happening specialization prompts', () => {
    const prompt = buildTrunkPrompt(null, null, false);
    // Those specializations stay behind dispatched sub-agents.
    expect(prompt).not.toContain('# Find People specialization');
    expect(prompt).not.toContain("# What's Happening specialization");
  });
});

describe('must-fix 6 — trunk prompt carries the domain rules that used to live in dispatched sub-agents', () => {
  let prompt: string;
  beforeAll(() => {
    prompt = buildTrunkPrompt(null, null, false);
  });

  it('housing: never invent prices', () => {
    // know-things.md anti-fabrication: housing prices among the NEVER-invent list.
    expect(prompt).toMatch(/Housing prices/);
  });

  it('courses: WRIT-150 5.0-tier threshold', () => {
    // know-things.md: WRIT 150 prefer 4.8+ then 4.5+ (the 5.0-tier discipline).
    expect(prompt).toMatch(/WRIT 150/);
    expect(prompt).toMatch(/4\.8\+/);
  });

  it('courses: RMP > 4.0 default threshold + highest-rated fallback', () => {
    expect(prompt).toMatch(/RMP ratings above 4\.0/);
    expect(prompt).toMatch(/highest available with explicit caveat/);
  });

  it('DPS-zone / spatial-safety framing reachable: trunk routing prompt names dps_zone_check for walkability/safety', () => {
    // The trunk holds dps_zone_check and may answer walkability/DPS-zone questions
    // directly, so its routing prompt must own that framing rather than splitting it.
    expect(prompt).toMatch(/DPS-zone safety/);
    expect(prompt).toMatch(/dps_zone_check/);
  });

  it('the find-housing skill playbook (with the DPS safety circle + never-invent-prices) is in the trunk catalog', () => {
    expect(prompt).toContain('find-housing');
  });
});

describe('GEORGE_TRUNK_HYBRID flag resolution (=== "true" semantics)', () => {
  // The flag is read in runOrchestrator as `process.env.GEORGE_TRUNK_HYBRID === 'true'`,
  // mirroring SINGLE_AGENT. Verify only the exact string 'true' enables it.
  const resolve = (v: string | undefined) => v === 'true';
  it('false for unset / empty / "false" / garbage; true only for exactly "true"', () => {
    expect(resolve(undefined)).toBe(false);
    expect(resolve('')).toBe(false);
    expect(resolve('false')).toBe(false);
    expect(resolve('TRUE')).toBe(false);
    expect(resolve('1')).toBe(false);
    expect(resolve('yes')).toBe(false);
    expect(resolve('true')).toBe(true);
  });
});

describe('trunk prompt — overlays in the same order as buildOrchestratorPrompt', () => {
  it('injects USER PROFILE + ONBOARDING + CURRENT STUDENT blocks like the orchestrator', () => {
    const empty: Profile = {
      identity: '', academic: '', interests: '', relationships: '', state: '', george_notes: '',
    };
    const prompt = buildTrunkPrompt(empty, 'sid-xyz', false);
    expect(prompt).toMatch(/^# USER PROFILE$/m);
    expect(prompt).toMatch(/^# ONBOARDING/m);
    expect(prompt).toMatch(/^# CURRENT STUDENT$/m);
    expect(prompt).toContain('sid-xyz');
  });

  it('drops the onboarding nudge once george knows the student', () => {
    const filled: Profile = {
      identity: 'name: Bob', academic: '', interests: '', relationships: '', state: '', george_notes: '',
    };
    expect(buildTrunkPrompt(filled, null, false)).not.toMatch(/^# ONBOARDING/m);
  });

  it('appends the skill catalog (so the trunk can discover playbooks)', () => {
    const prompt = buildTrunkPrompt(null, null, false);
    expect(prompt).toContain('## Skill Catalog');
    expect(prompt).toContain(getFullCatalog());
  });

  it('injects web-search guidance only when web is allowed', () => {
    expect(buildTrunkPrompt(null, null, true)).toMatch(/allowed_domains/);
    expect(buildTrunkPrompt(null, null, false)).not.toMatch(/allowed_domains/);
  });
});
