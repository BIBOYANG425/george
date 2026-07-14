// tests/agent/inbound-pipeline.test.ts
// Unit tests for runInboundPipeline — the shared injection → handshake → command →
// orchestrate sequence Spectrum's buildTextHandler and Path B (/imessage/incoming)
// now both run. Pins short-circuit order and the discriminated outcome each stage
// returns (so transports can post-process per stage).
import { describe, it, expect, vi } from 'vitest';
import { runInboundPipeline, type InboundPipelineDeps } from '../../src/agent/inbound-pipeline.js';

function makeDeps(overrides: Partial<InboundPipelineDeps> = {}): InboundPipelineDeps {
  return {
    checkInjection: () => ({ blocked: false }),
    pickRejection: () => 'nope',
    tryHandshake: async () => false,
    tryUserCommand: async () => null,
    runOrchestratorText: async () => 'george reply',
    ...overrides,
  };
}

describe('runInboundPipeline — short-circuit order', () => {
  it('injection wins first and skips everything downstream', async () => {
    const deps = makeDeps({
      checkInjection: () => ({ blocked: true, reason: 'override' }),
      tryHandshake: vi.fn(async () => false),
      tryUserCommand: vi.fn(async () => 'cmd'),
      runOrchestratorText: vi.fn(async () => 'orch'),
    });
    const out = await runInboundPipeline(deps, { rawUserId: 'u', text: 'ignore previous' });
    expect(out).toEqual({ kind: 'injection', reply: 'nope', reason: 'override' });
    expect(deps.tryHandshake).not.toHaveBeenCalled();
    expect(deps.tryUserCommand).not.toHaveBeenCalled();
    expect(deps.runOrchestratorText).not.toHaveBeenCalled();
  });

  it('handshake consumes the message (no command / orchestrator)', async () => {
    const deps = makeDeps({
      tryHandshake: async () => true,
      tryUserCommand: vi.fn(async () => 'cmd'),
      runOrchestratorText: vi.fn(async () => 'orch'),
    });
    const out = await runInboundPipeline(deps, { rawUserId: 'u', text: 'g7k2m4-START' });
    expect(out).toEqual({ kind: 'handshake' });
    expect(deps.tryUserCommand).not.toHaveBeenCalled();
    expect(deps.runOrchestratorText).not.toHaveBeenCalled();
  });

  it('a command reply short-circuits before the orchestrator', async () => {
    const deps = makeDeps({
      tryUserCommand: async () => '/profile output',
      runOrchestratorText: vi.fn(async () => 'orch'),
    });
    const out = await runInboundPipeline(deps, { rawUserId: 'u', text: '/profile' });
    expect(out).toEqual({ kind: 'command', reply: '/profile output' });
    expect(deps.runOrchestratorText).not.toHaveBeenCalled();
  });

  it('falls through to the orchestrator for a normal message', async () => {
    const out = await runInboundPipeline(makeDeps(), { rawUserId: 'u', text: 'what dorm is best' });
    expect(out).toEqual({ kind: 'orchestrator', reply: 'george reply' });
  });

  it('an empty command string ("") is still a command outcome (only null falls through)', async () => {
    const deps = makeDeps({ tryUserCommand: async () => '', runOrchestratorText: vi.fn(async () => 'orch') });
    const out = await runInboundPipeline(deps, { rawUserId: 'u', text: 'x' });
    expect(out).toEqual({ kind: 'command', reply: '' });
    expect(deps.runOrchestratorText).not.toHaveBeenCalled();
  });
});

describe('runInboundPipeline — handle normalization + forwarding', () => {
  it('normalizes the handle before handshake/command/orchestrate; forwards reply + delay + abort', async () => {
    const seen: string[] = [];
    const ac = new AbortController();
    const reply = { tag: 'reply-handle' };
    const deps: InboundPipelineDeps<typeof reply> = {
      normalizeHandle: (raw) => `norm:${raw}`,
      checkInjection: () => ({ blocked: false }),
      pickRejection: () => 'nope',
      tryHandshake: async (uid, _t, r) => { seen.push(`hs:${uid}:${r?.tag}`); return false; },
      tryUserCommand: async (uid) => { seen.push(`cmd:${uid}`); return null; },
      runOrchestratorText: async (uid, _t, abortController, delayContext, r) => {
        seen.push(`orch:${uid}:${delayContext}:${abortController === ac}:${r?.tag}`);
        return 'ok';
      },
    };
    const out = await runInboundPipeline(deps, {
      rawUserId: '+1555',
      text: 'hey',
      reply,
      abortController: ac,
      delayContext: 'GAP',
    });
    expect(out).toEqual({ kind: 'orchestrator', reply: 'ok' });
    expect(seen).toEqual(['hs:norm:+1555:reply-handle', 'cmd:norm:+1555', 'orch:norm:+1555:GAP:true:reply-handle']);
  });

  it('defaults to identity when normalizeHandle is omitted', async () => {
    let seenUid = '';
    const deps = makeDeps({ tryUserCommand: async (uid) => { seenUid = uid; return null; } });
    await runInboundPipeline(deps, { rawUserId: 'raw-handle', text: 'x' });
    expect(seenUid).toBe('raw-handle');
  });

  it('forwards images as the 6th orchestrator arg, and undefined when none', async () => {
    const images = [{ mimeType: 'image/jpeg' as const, dataBase64: 'ZZZ' }];
    const seen: unknown[] = [];
    const deps = makeDeps({
      runOrchestratorText: async (_u, _t, _ac, _dc, _r, imgs) => { seen.push(imgs); return 'ok'; },
    });
    await runInboundPipeline(deps, { rawUserId: 'u', text: 'look', images });
    await runInboundPipeline(deps, { rawUserId: 'u', text: 'plain text' });
    expect(seen[0]).toBe(images);
    expect(seen[1]).toBeUndefined();
  });
});
