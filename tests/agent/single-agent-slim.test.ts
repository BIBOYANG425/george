// tests/agent/single-agent-slim.test.ts
//
// Characterizes the SLIM single-agent prompt variant (SINGLE_AGENT_PROMPT=slim):
// voice (master.md) + domain-core red-lines stay always-loaded, domain PROCEDURE
// moves to on-demand skills, ORCHESTRATOR_PROMPT's dispatch talk is dropped, and
// the skill catalog is present WITH the new domain playbooks (the registry now
// lazy-loads on the orchestrator path — eval runs used to see an empty catalog).
// Default (unset) stays byte-compatible with the merged prompt.
//
// Header last reviewed: 2026-07-01

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildSingleAgentPrompt } from '../../src/agent/orchestrator.js';
import { ensureSkillsLoaded } from '../../src/skills/index.js';
import { ALL_TOOLS } from '../../src/tools/index.js';

const KEY = 'SINGLE_AGENT_PROMPT';
const saved = process.env[KEY];

beforeAll(async () => {
  await ensureSkillsLoaded(new Set(Object.keys(ALL_TOOLS)));
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('SINGLE_AGENT_PROMPT=slim', () => {
  it('default (unset) keeps the merged prompt: unified domains + orchestrator text', () => {
    delete process.env[KEY];
    const p = buildSingleAgentPrompt();
    expect(p).toContain('# DOMAINS YOU HANDLE'); // UNIFIED_DOMAIN_PROMPT marker
    expect(p).toContain('Sub-agents available'); // orchestrator.md marker
  });

  it('slim drops the merged domain prompts and the dispatch talk', () => {
    process.env[KEY] = 'slim';
    const p = buildSingleAgentPrompt();
    expect(p).not.toContain('# DOMAINS YOU HANDLE');
    expect(p).not.toContain('Sub-agents available');
    // A know-things procedure detail that must now live ONLY in skills:
    expect(p).not.toContain('search_ge_courses` with that');
  });

  it('slim keeps voice + red-lines always-loaded', () => {
    process.env[KEY] = 'slim';
    const p = buildSingleAgentPrompt();
    expect(p).toContain('george'); // master.md identity
    expect(p).toContain('No em dashes'); // master.md voice law
    expect(p).toContain('Red lines'); // domain-core section
    expect(p).toContain('NEVER call create_squad_post'); // approval gate stays inlined
    expect(p).toContain('writ150 means rmp 5.0'); // hardest domain law survives slim
  });

  it('slim carries the skill catalog including the new domain playbooks', () => {
    process.env[KEY] = 'slim';
    const p = buildSingleAgentPrompt();
    expect(p).toContain('## Skill Catalog');
    expect(p).toContain('organize-squad');
    expect(p).toContain('event-curation');
    expect(p).toContain('course-recommendation');
  });

  it('slim is materially smaller than merged (the whole point)', () => {
    delete process.env[KEY];
    const merged = buildSingleAgentPrompt().length;
    process.env[KEY] = 'slim';
    const slim = buildSingleAgentPrompt().length;
    expect(slim).toBeLessThan(merged * 0.75);
  });
});
