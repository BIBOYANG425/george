// tests/agent/llm-routing.test.ts
// callLightweightLLM model routing (P3 fix): an Anthropic model id (the SMART
// tier the relationship evaluator asks for) must run on Claude even when a Kimi
// key is configured — otherwise it silently downgrades to moonshot-v1-8k.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-anthropic' },
    kimi: { apiKey: 'test-kimi', baseUrl: 'https://kimi.example' },
    models: { fast: 'claude-sonnet-4-6', smart: 'claude-sonnet-4-6' },
  },
}));

vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import { callLightweightLLM } from '../../src/agent/llm-providers.js';

describe('callLightweightLLM model routing (Kimi key present)', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'claude-ok' }] });
  });

  it('routes an Anthropic SMART model to Claude even when a Kimi key is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await callLightweightLLM([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-4-6',
    });
    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toBe('claude-ok');
    fetchSpy.mockRestore();
  });

  it('keeps the default (no model) lightweight call on the Kimi path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'kimi-ok' } }] }),
    } as unknown as Response);
    const out = await callLightweightLLM([{ role: 'user', content: 'hi' }]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(createMock).not.toHaveBeenCalled();
    expect(out).toBe('kimi-ok');
    fetchSpy.mockRestore();
  });
});
