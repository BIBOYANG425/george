// tests/agent/fast-path-emotional.test.ts
//
// PR-2 emotional-tier routing in fastReply: a per-user emotionalModel routes by
// id-prefix (doubao→Ark, gpt→OpenAI, else→lightweight); null is byte-identical to
// the original default; explicit-model failure falls back to lightweight.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { doubaoChat, isDoubaoConfigured, openaiFastReply, callLightweightLLM } = vi.hoisted(() => ({
  doubaoChat: vi.fn(),
  isDoubaoConfigured: vi.fn(() => true),
  openaiFastReply: vi.fn(),
  callLightweightLLM: vi.fn(),
}));

vi.mock('../../src/agent/doubao-client.js', () => ({ doubaoChat, isDoubaoConfigured }));
vi.mock('../../src/agent/openai-fast-client.js', () => ({ openaiFastReply }));
vi.mock('../../src/agent/llm-providers.js', () => ({ callLightweightLLM }));
vi.mock('../../src/agent/agents.config.js', () => ({ MASTER_PROMPT: 'M' }));
vi.mock('../../src/agent/calendar-mood.js', () => ({ renderMoodBlock: () => '', renderDateBlock: () => '' }));
vi.mock('../../src/agent/fast-path-guard.js', () => ({ scanFabricationRisk: () => [] }));

import { fastReply } from '../../src/agent/fast-path.js';

const base = { text: 'hi 学长', historyPrefix: '', profileBlock: '' };

beforeEach(() => {
  doubaoChat.mockReset().mockResolvedValue('在的哈哈哈');
  openaiFastReply.mockReset().mockResolvedValue('hey there');
  callLightweightLLM.mockReset().mockResolvedValue('lightweight reply');
  isDoubaoConfigured.mockReset().mockReturnValue(true);
});

describe('fastReply — emotional-model routing', () => {
  it('doubao id → doubaoChat with the per-user model', async () => {
    const r = await fastReply({ ...base, emotionalModel: 'doubao-seed-2-0-lite-260215' });
    expect(doubaoChat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: 'doubao-seed-2-0-lite-260215' }));
    expect(openaiFastReply).not.toHaveBeenCalled();
    expect(r).toBe('在的哈哈哈');
  });

  it('gpt id → openaiFastReply (NOT callLightweightLLM, which would downgrade to moonshot)', async () => {
    await fastReply({ ...base, emotionalModel: 'gpt-4o-mini' });
    expect(openaiFastReply).toHaveBeenCalledWith(expect.anything(), 'gpt-4o-mini', expect.anything());
    expect(doubaoChat).not.toHaveBeenCalled();
    expect(callLightweightLLM).not.toHaveBeenCalled();
  });

  it('claude id → callLightweightLLM with the model (Anthropic SDK)', async () => {
    await fastReply({ ...base, emotionalModel: 'claude-sonnet-4-6' });
    expect(callLightweightLLM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: 'claude-sonnet-4-6' }));
    expect(doubaoChat).not.toHaveBeenCalled();
    expect(openaiFastReply).not.toHaveBeenCalled();
  });

  it('null/unset → default path: Doubao when configured, NO model override', async () => {
    await fastReply({ ...base });
    expect(doubaoChat).toHaveBeenCalledTimes(1);
    expect(doubaoChat.mock.calls[0][1]?.model).toBeUndefined();
    expect(openaiFastReply).not.toHaveBeenCalled();
  });

  it('null + Doubao NOT configured → lightweight, no model', async () => {
    isDoubaoConfigured.mockReturnValue(false);
    await fastReply({ ...base });
    expect(callLightweightLLM).toHaveBeenCalledTimes(1);
    expect(callLightweightLLM.mock.calls[0][1]?.model).toBeUndefined();
    expect(doubaoChat).not.toHaveBeenCalled();
  });

  it('explicit-model failure falls back to the lightweight tier (no model)', async () => {
    openaiFastReply.mockRejectedValue(new Error('boom'));
    const r = await fastReply({ ...base, emotionalModel: 'gpt-4o-mini' });
    expect(callLightweightLLM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxTokens: 350 }));
    expect(callLightweightLLM.mock.calls[0][1]?.model).toBeUndefined();
    expect(r).toBe('lightweight reply');
  });
})
