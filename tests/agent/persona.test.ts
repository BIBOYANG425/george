// tests/agent/persona.test.ts
import { describe, it, expect } from 'vitest';
import { MASTER_PROMPT, SUB_AGENTS } from '../../src/agent/agents.config';

describe('persona consistency', () => {
  it('master prompt contains identity rules', () => {
    expect(MASTER_PROMPT).toMatch(/george/i);
    expect(MASTER_PROMPT).toMatch(/lowercase/i);
    expect(MASTER_PROMPT).toMatch(/戳到知识盲区了/);
    expect(MASTER_PROMPT).toMatch(/source/i);
  });

  it('all sub-agents inherit master prompt', () => {
    for (const [name, def] of Object.entries(SUB_AGENTS)) {
      expect(def.prompt.startsWith(MASTER_PROMPT), `${name} must start with MASTER_PROMPT`).toBe(true);
    }
  });

  it('all sub-agents prohibit fabrication', () => {
    for (const [name, def] of Object.entries(SUB_AGENTS)) {
      expect(def.prompt, `${name} missing anti-fabrication`).toMatch(/戳到知识盲区了|fabricat/i);
    }
  });

  it('no sub-agent prompt contains banned em-dash', () => {
    for (const [name, def] of Object.entries(SUB_AGENTS)) {
      expect(def.prompt, `${name} has em dash`).not.toMatch(/—/);
    }
  });

  it('no sub-agent prompt contains banned 不是…而是 structure', () => {
    for (const [name, def] of Object.entries(SUB_AGENTS)) {
      expect(def.prompt, `${name} has 不是…而是`).not.toMatch(/不是.{0,30}而是/);
    }
  });
});
