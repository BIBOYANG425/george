// tests/agent/recall-injection.test.ts
// Covers P6 observational-memory recall injection into the per-turn system prompt
// on ALL FOUR agent paths: orchestrator multi-agent (buildOrchestratorPrompt),
// single-agent (buildSingleAgentPrompt), trunk-hybrid (buildTrunkPrompt), and the
// fast-path (fastReply -> FAST_INSTRUCTION assembly).
//
// recallForTurn() is gated by GEORGE_RECALL_ENABLED and returns '' when unset, so
// the recallBlock threaded through these builders defaults to '' — making the OFF
// path byte-identical to pre-recall behavior. These tests assert two things per
// builder: (1) a non-empty recallBlock argument is included verbatim in the output,
// (2) the default ('' / omitted) argument leaves the output byte-identical and free
// of the recall header.

import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';

// Mock the fast-path's LLM seams so fastReply runs offline and we can capture the
// exact system prompt it assembles. Doubao reports unconfigured → the lightweight
// path is taken; callLightweightLLM records the system message and returns a reply.
const { lightweightMock } = vi.hoisted(() => ({ lightweightMock: vi.fn() }));
vi.mock('../../src/agent/llm-providers.js', () => ({
  callLightweightLLM: lightweightMock,
  getClaudeClient: vi.fn(),
}));
vi.mock('../../src/agent/doubao-client.js', () => ({
  isDoubaoConfigured: () => false,
  doubaoChat: vi.fn(),
}));
vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import {
  buildOrchestratorPrompt,
  buildSingleAgentPrompt,
  buildTrunkPrompt,
} from '../../src/agent/orchestrator.js';
import { fastReply } from '../../src/agent/fast-path.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { loadAllSkills, _resetForTest } from '../../src/skills/index.js';

// buildSingleAgentPrompt / buildTrunkPrompt append getFullCatalog(); build the
// catalog so the prompts assemble exactly as they do at runtime.
beforeAll(async () => {
  _resetForTest();
  await loadAllSkills(new Set(Object.keys(ALL_TOOLS)));
});

const RECALL = '## THINGS YOU REMEMBER\n- sleeps at 3am\n- celebrated a Pear offer';
const RECALL_HEADER = '## THINGS YOU REMEMBER';

describe('recall injection — buildOrchestratorPrompt (multi-agent path)', () => {
  it('includes the recall block verbatim when non-empty', () => {
    const prompt = buildOrchestratorPrompt(null, null, undefined, '', false, RECALL);
    expect(prompt).toContain(RECALL);
  });

  it('OFF path: omitting the recall block leaves the prompt byte-identical (no header)', () => {
    const withDefault = buildOrchestratorPrompt(null, null, undefined, '', false);
    const withEmpty = buildOrchestratorPrompt(null, null, undefined, '', false, '');
    expect(withDefault).toBe(withEmpty);
    expect(withDefault).not.toContain(RECALL_HEADER);
  });
});

describe('recall injection — buildSingleAgentPrompt (SINGLE_AGENT path)', () => {
  it('includes the recall block verbatim when non-empty', () => {
    const prompt = buildSingleAgentPrompt(null, null, false, undefined, '', RECALL);
    expect(prompt).toContain(RECALL);
  });

  it('OFF path: omitting the recall block leaves the prompt byte-identical (no header)', () => {
    const withDefault = buildSingleAgentPrompt(null, null, false, undefined, '');
    const withEmpty = buildSingleAgentPrompt(null, null, false, undefined, '', '');
    expect(withDefault).toBe(withEmpty);
    expect(withDefault).not.toContain(RECALL_HEADER);
  });
});

describe('recall injection — buildTrunkPrompt (GEORGE_TRUNK_HYBRID path)', () => {
  it('includes the recall block verbatim when non-empty', () => {
    const prompt = buildTrunkPrompt(null, null, false, undefined, '', RECALL);
    expect(prompt).toContain(RECALL);
  });

  it('OFF path: omitting the recall block leaves the prompt byte-identical (no header)', () => {
    const withDefault = buildTrunkPrompt(null, null, false, undefined, '');
    const withEmpty = buildTrunkPrompt(null, null, false, undefined, '', '');
    expect(withDefault).toBe(withEmpty);
    expect(withDefault).not.toContain(RECALL_HEADER);
  });
});

describe('recall injection — fastReply (fast-path)', () => {
  beforeEach(() => {
    lightweightMock.mockReset();
    lightweightMock.mockResolvedValue('hihi 学长在');
  });

  it('includes the recall block verbatim in the fast-path system prompt when non-empty', async () => {
    await fastReply({ text: 'hi', historyPrefix: '', profileBlock: '', recallBlock: RECALL });
    expect(lightweightMock).toHaveBeenCalledOnce();
    const system = lightweightMock.mock.calls[0][0][0].content as string;
    expect(system).toContain(RECALL);
  });

  it('OFF path: omitting the recall block leaves the system prompt free of the header', async () => {
    await fastReply({ text: 'hi', historyPrefix: '', profileBlock: '' });
    const system = lightweightMock.mock.calls[0][0][0].content as string;
    expect(system).not.toContain(RECALL_HEADER);
  });
});
