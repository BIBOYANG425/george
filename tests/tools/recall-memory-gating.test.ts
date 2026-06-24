// tests/tools/recall-memory-gating.test.ts
// P6 Phase 5 gating: GEORGE_RECALL_TOOL_ENABLED (default-OFF). ALL_TOOLS and
// ORCHESTRATOR_DIRECT_TOOLS are evaluated ONCE at module load (the flag is read at
// import time, in lockstep with the in-process MCP server registration), so each
// flag state is exercised with a fresh module graph via vi.resetModules() + dynamic
// import. Proves the tool is ABSENT from every assembled tool set when the flag is
// unset (byte-identical OFF) and PRESENT when set.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Importing tools/index → recall-memory builds a real service-role client lazily;
// @supabase/supabase-js validates the URL at construction. Set dummies (repo idiom).
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const NS = (n: string) => `mcp__george__${n}`;

async function loadWithFlag(on: boolean) {
  vi.resetModules();
  if (on) process.env.GEORGE_RECALL_TOOL_ENABLED = 'true';
  else delete process.env.GEORGE_RECALL_TOOL_ENABLED;
  const tools = await import('../../src/tools/index.js');
  const agents = await import('../../src/agent/agents.config.js');
  return {
    ALL_TOOLS: tools.ALL_TOOLS as Record<string, unknown>,
    ORCHESTRATOR_DIRECT_TOOLS: agents.ORCHESTRATOR_DIRECT_TOOLS as readonly string[],
    TRUNK_TOOLS: agents.TRUNK_TOOLS as readonly string[],
  };
}

const orig = process.env.GEORGE_RECALL_TOOL_ENABLED;
beforeEach(() => { delete process.env.GEORGE_RECALL_TOOL_ENABLED; });
afterEach(() => {
  if (orig === undefined) delete process.env.GEORGE_RECALL_TOOL_ENABLED;
  else process.env.GEORGE_RECALL_TOOL_ENABLED = orig;
  vi.resetModules();
});

describe('recall_memory gating — OFF (default)', () => {
  it('tool absent from ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, and TRUNK_TOOLS', async () => {
    const { ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, TRUNK_TOOLS } = await loadWithFlag(false);
    expect(ALL_TOOLS.recall_memory).toBeUndefined();
    expect(Object.keys(ALL_TOOLS)).not.toContain('recall_memory');
    expect(ORCHESTRATOR_DIRECT_TOOLS).not.toContain('recall_memory');
    expect(TRUNK_TOOLS).not.toContain('recall_memory');
    // The 3 pre-existing direct tools are still exactly what they were.
    expect([...ORCHESTRATOR_DIRECT_TOOLS]).toEqual(['set_reminder', 'load_skill', 'react_to_user']);
  });
});

describe('recall_memory gating — ON', () => {
  it('tool present in ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, and (via spread) TRUNK_TOOLS', async () => {
    const { ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, TRUNK_TOOLS } = await loadWithFlag(true);
    expect(ALL_TOOLS.recall_memory).toBeDefined();
    expect(Object.keys(ALL_TOOLS)).toContain('recall_memory');
    expect(ORCHESTRATOR_DIRECT_TOOLS).toContain('recall_memory');
    // TRUNK_TOOLS spreads ORCHESTRATOR_DIRECT_TOOLS, so it inherits the tool.
    expect(TRUNK_TOOLS).toContain('recall_memory');
  });

  it('single-agent / orchestrator allowlists (Object.keys(ALL_TOOLS).map(ns)) include it when ON', async () => {
    const { ALL_TOOLS } = await loadWithFlag(true);
    const allToolsNs = Object.keys(ALL_TOOLS).map(NS);
    expect(allToolsNs).toContain(NS('recall_memory'));
  });
});

// Prompt byte-identity: the new `handle` param threaded into the 3 full-agent
// builders is a strict no-op when the flag is OFF (the recall-tool context block
// is '' on that path), so OFF stays byte-for-byte unchanged regardless of handle.
describe('recall_memory gating — prompt byte-identity OFF', () => {
  it('handle param is a no-op in all 3 builders when both memory-tool flags OFF (no # MEMORY TOOLS)', async () => {
    vi.resetModules();
    delete process.env.GEORGE_RECALL_TOOL_ENABLED;
    delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
    const o = await import('../../src/agent/orchestrator.js');
    const HANDLE = '+17474638880';

    const orch0 = o.buildOrchestratorPrompt(null, 'sid', undefined, '', false, '');
    const orchH = o.buildOrchestratorPrompt(null, 'sid', undefined, '', false, '', HANDLE);
    expect(orchH).toBe(orch0);
    expect(orchH).not.toContain('# MEMORY TOOLS');

    const single0 = o.buildSingleAgentPrompt(null, 'sid', false, undefined, '', '');
    const singleH = o.buildSingleAgentPrompt(null, 'sid', false, undefined, '', '', HANDLE);
    expect(singleH).toBe(single0);
    expect(singleH).not.toContain('# MEMORY TOOLS');

    const trunk0 = o.buildTrunkPrompt(null, 'sid', false, undefined, '', '');
    const trunkH = o.buildTrunkPrompt(null, 'sid', false, undefined, '', '', HANDLE);
    expect(trunkH).toBe(trunk0);
    expect(trunkH).not.toContain('# MEMORY TOOLS');
  });

  it('handle param surfaces the # MEMORY TOOLS block (mentioning recall_memory) when recall flag ON', async () => {
    vi.resetModules();
    process.env.GEORGE_RECALL_TOOL_ENABLED = 'true';
    delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
    const o = await import('../../src/agent/orchestrator.js');
    const HANDLE = '+17474638880';
    const prompt = o.buildOrchestratorPrompt(null, 'sid', undefined, '', false, '', HANDLE);
    expect(prompt).toContain('# MEMORY TOOLS');
    expect(prompt).toContain('recall_memory');
    expect(prompt).not.toContain('update_memory'); // only the enabled tool is advertised
    expect(prompt).toContain(HANDLE);
  });
});
