// tests/tools/update-memory-gating.test.ts
// GEORGE_UPDATE_MEMORY_TOOL_ENABLED (default-OFF) gating, mirroring
// recall-memory-gating.test.ts. ALL_TOOLS and ORCHESTRATOR_DIRECT_TOOLS read the
// flag ONCE at module load (in lockstep with the in-process MCP registration), so
// each flag state runs against a fresh module graph via resetModules + dynamic
// import. Proves the tool is ABSENT everywhere when OFF (byte-identical) and PRESENT
// when ON, and that the # MEMORY TOOLS prompt block advertises ONLY update_memory
// when it alone is enabled (codex #8 — never advertise an absent tool).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

async function loadWithFlag(on: boolean) {
  vi.resetModules();
  if (on) process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED = 'true';
  else delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
  delete process.env.GEORGE_RECALL_TOOL_ENABLED; // isolate from the recall flag
  const tools = await import('../../src/tools/index.js');
  const agents = await import('../../src/agent/agents.config.js');
  return {
    ALL_TOOLS: tools.ALL_TOOLS as Record<string, unknown>,
    ORCHESTRATOR_DIRECT_TOOLS: agents.ORCHESTRATOR_DIRECT_TOOLS as readonly string[],
    TRUNK_TOOLS: agents.TRUNK_TOOLS as readonly string[],
  };
}

const origUpdate = process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
const origRecall = process.env.GEORGE_RECALL_TOOL_ENABLED;
beforeEach(() => {
  delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
  delete process.env.GEORGE_RECALL_TOOL_ENABLED;
});
afterEach(() => {
  if (origUpdate === undefined) delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
  else process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED = origUpdate;
  if (origRecall === undefined) delete process.env.GEORGE_RECALL_TOOL_ENABLED;
  else process.env.GEORGE_RECALL_TOOL_ENABLED = origRecall;
  vi.resetModules();
});

describe('update_memory gating — OFF (default)', () => {
  it('tool absent from ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, and TRUNK_TOOLS', async () => {
    const { ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, TRUNK_TOOLS } = await loadWithFlag(false);
    expect(ALL_TOOLS.update_memory).toBeUndefined();
    expect(ORCHESTRATOR_DIRECT_TOOLS).not.toContain('update_memory');
    expect(TRUNK_TOOLS).not.toContain('update_memory');
    // With BOTH memory-tool flags off, the direct-tool list is exactly the 3 base tools.
    expect([...ORCHESTRATOR_DIRECT_TOOLS]).toEqual(['set_reminder', 'load_skill', 'react_to_user']);
  });
});

describe('update_memory gating — ON', () => {
  it('tool present in ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, and (via spread) TRUNK_TOOLS', async () => {
    const { ALL_TOOLS, ORCHESTRATOR_DIRECT_TOOLS, TRUNK_TOOLS } = await loadWithFlag(true);
    expect(ALL_TOOLS.update_memory).toBeDefined();
    expect(ORCHESTRATOR_DIRECT_TOOLS).toContain('update_memory');
    expect(TRUNK_TOOLS).toContain('update_memory');
  });
});

// Issue 1 + codex #8: the handle-context block must be present (so the model can
// pass user_id) when ONLY update_memory is on — and its wording must advertise
// update_memory, NOT recall_memory (the absent tool).
describe('update_memory gating — handle injection + wording', () => {
  it('only update_memory ON → # MEMORY TOOLS block injects the handle and mentions update_memory, not recall_memory', async () => {
    vi.resetModules();
    process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED = 'true';
    delete process.env.GEORGE_RECALL_TOOL_ENABLED;
    const o = await import('../../src/agent/orchestrator.js');
    const HANDLE = '+17474638880';
    const prompt = o.buildOrchestratorPrompt(null, 'sid', undefined, '', false, '', HANDLE);
    expect(prompt).toContain('# MEMORY TOOLS');
    expect(prompt).toContain('update_memory');
    expect(prompt).not.toContain('recall_memory'); // recall tool is OFF → not advertised
    expect(prompt).toContain(HANDLE);
  });

  it('both memory-tool flags OFF → no # MEMORY TOOLS block (byte-identical handle no-op)', async () => {
    vi.resetModules();
    delete process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED;
    delete process.env.GEORGE_RECALL_TOOL_ENABLED;
    const o = await import('../../src/agent/orchestrator.js');
    const HANDLE = '+17474638880';
    const base = o.buildOrchestratorPrompt(null, 'sid', undefined, '', false, '');
    const withHandle = o.buildOrchestratorPrompt(null, 'sid', undefined, '', false, '', HANDLE);
    expect(withHandle).toBe(base);
    expect(withHandle).not.toContain('# MEMORY TOOLS');
  });
});
