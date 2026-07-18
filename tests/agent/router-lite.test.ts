// tests/agent/router-lite.test.ts
//
// george-lite (liteReply) is a thin wrapper over fastReply that swaps in the
// confident LITE_INSTRUCTION. It must forward every arg, carry the lite instruction,
// propagate fastReply's null bail (fabrication scan / NEEDS_AGENT → full agent), and
// thread the per-user emotionalModel.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fastReply } = vi.hoisted(() => ({ fastReply: vi.fn() }));
vi.mock('../../src/agent/fast-path.js', () => ({ fastReply, NEEDS_AGENT: 'NEEDS_AGENT' }));
vi.mock('../../src/agent/llm-providers.js', () => ({ callLightweightLLM: vi.fn() }));
vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import { liteReply } from '../../src/agent/router.js';

const base = { text: 'hi 学长', historyPrefix: '', profileBlock: '' };

beforeEach(() => {
  fastReply.mockReset();
});

describe('liteReply', () => {
  it('forwards to fastReply with the LITE_INSTRUCTION and returns its text', async () => {
    fastReply.mockResolvedValue('yo 学长在哈哈');
    const r = await liteReply({ ...base });
    expect(r).toBe('yo 学长在哈哈');
    const arg = fastReply.mock.calls[0][0];
    expect(arg.text).toBe('hi 学长');
    expect(typeof arg.instruction).toBe('string');
    expect(arg.instruction).toContain('DIRECT RESPONDER MODE');
    // the anti-fabrication warmth-trap block is carried through verbatim
    expect(arg.instruction).toContain('OFFER vs ASSERT');
    expect(arg.instruction).toContain('NEEDS_AGENT');
  });

  it('propagates a null bail (fabrication scan / NEEDS_AGENT) unchanged', async () => {
    fastReply.mockResolvedValue(null);
    expect(await liteReply({ ...base })).toBeNull();
  });

  it('threads the per-user emotionalModel through to fastReply', async () => {
    fastReply.mockResolvedValue('ok');
    await liteReply({ ...base, emotionalModel: 'doubao-seed-2-0-lite-260215', recallBlock: 'R' });
    const arg = fastReply.mock.calls[0][0];
    expect(arg.emotionalModel).toBe('doubao-seed-2-0-lite-260215');
    expect(arg.recallBlock).toBe('R');
  });
});
