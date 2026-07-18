// tests/agent/router-decide.test.ts
//
// decideCheapPath is the single seam runOrchestrator uses for the cheap path. It
// resolves the THREE mutually-exclusive modes and returns an 'answered' outcome
// (caller yields result + telemetry, returns) or a 'fallthrough' (run the full
// agent, carrying the router verdict/latency). These tests pin:
//   - router OFF → the legacy fast path runs and the classifier is NEVER called
//     (the byte-identity guarantee),
//   - GEORGE_DISABLE_FAST_PATH → neither cheap path runs,
//   - router ON → general answers via george-lite; general+bail and full fall
//     through with routeVerdict 'full'; images route full without classifying.
//
// ENV ISOLATION (CRITICAL): flips GEORGE_ROUTER_ENABLED / GEORGE_DISABLE_FAST_PATH.
// A leaked flag would corrupt other suites — snapshot+restore both in before/after.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { callLightweightLLM, fastReply } = vi.hoisted(() => ({
  callLightweightLLM: vi.fn(),
  fastReply: vi.fn(),
}));
vi.mock('../../src/agent/llm-providers.js', () => ({ callLightweightLLM }));
vi.mock('../../src/agent/fast-path.js', () => ({ fastReply, NEEDS_AGENT: 'NEEDS_AGENT' }));
vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import { decideCheapPath } from '../../src/agent/router.js';

const base = { channel: 'imessage', text: 'hi', historyPrefix: '', hasImages: false, profileBlock: '' };

let savedRouter: string | undefined;
let savedDisable: string | undefined;
beforeEach(() => {
  savedRouter = process.env.GEORGE_ROUTER_ENABLED;
  savedDisable = process.env.GEORGE_DISABLE_FAST_PATH;
  delete process.env.GEORGE_ROUTER_ENABLED;
  delete process.env.GEORGE_DISABLE_FAST_PATH;
  callLightweightLLM.mockReset();
  fastReply.mockReset();
});
afterEach(() => {
  if (savedRouter === undefined) delete process.env.GEORGE_ROUTER_ENABLED;
  else process.env.GEORGE_ROUTER_ENABLED = savedRouter;
  if (savedDisable === undefined) delete process.env.GEORGE_DISABLE_FAST_PATH;
  else process.env.GEORGE_DISABLE_FAST_PATH = savedDisable;
});

describe('decideCheapPath — router OFF (legacy fast path, byte-identical)', () => {
  it('fast reply answers → answered with fast_path telemetry, classifier never called', async () => {
    fastReply.mockResolvedValue('在的哈哈哈');
    const out = await decideCheapPath({ ...base });
    expect(out).toEqual({
      kind: 'answered',
      result: '在的哈哈哈',
      telemetry: { channel: 'imessage', outcome: 'fast_path', model: 'fast', tools: [] },
    });
    expect(callLightweightLLM).not.toHaveBeenCalled();
  });

  it('fast reply bails (null) → fallthrough with no router verdict', async () => {
    fastReply.mockResolvedValue(null);
    const out = await decideCheapPath({ ...base });
    expect(out).toEqual({ kind: 'fallthrough' });
    expect(callLightweightLLM).not.toHaveBeenCalled();
  });

  it('images → fastReply skipped, fallthrough, classifier never called', async () => {
    const out = await decideCheapPath({ ...base, hasImages: true });
    expect(out).toEqual({ kind: 'fallthrough' });
    expect(fastReply).not.toHaveBeenCalled();
    expect(callLightweightLLM).not.toHaveBeenCalled();
  });
});

describe('decideCheapPath — GEORGE_DISABLE_FAST_PATH', () => {
  it('suppresses BOTH cheap paths → plain fallthrough', async () => {
    process.env.GEORGE_DISABLE_FAST_PATH = 'true';
    process.env.GEORGE_ROUTER_ENABLED = 'true'; // disable wins over router
    const out = await decideCheapPath({ ...base });
    expect(out).toEqual({ kind: 'fallthrough' });
    expect(callLightweightLLM).not.toHaveBeenCalled();
    expect(fastReply).not.toHaveBeenCalled();
  });
});

describe('decideCheapPath — router ON', () => {
  beforeEach(() => { process.env.GEORGE_ROUTER_ENABLED = 'true'; });

  it('general verdict + lite answers → answered with router_general telemetry', async () => {
    callLightweightLLM.mockResolvedValue('{"route":"general"}');
    fastReply.mockResolvedValue('闭包就是…');
    const out = await decideCheapPath({ ...base, text: '解释一下闭包' });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') throw new Error('unreachable');
    expect(out.result).toBe('闭包就是…');
    expect(out.telemetry).toMatchObject({
      channel: 'imessage', outcome: 'router_general', model: 'fast', tools: [], routeVerdict: 'general',
    });
    expect(typeof out.telemetry.classifyMs).toBe('number');
  });

  it('general verdict but lite bails → fallthrough with routeVerdict full', async () => {
    callLightweightLLM.mockResolvedValue('{"route":"general"}');
    fastReply.mockResolvedValue(null); // fabrication scan / NEEDS_AGENT
    const out = await decideCheapPath({ ...base });
    expect(out.kind).toBe('fallthrough');
    if (out.kind !== 'fallthrough') throw new Error('unreachable');
    expect(out.routeVerdict).toBe('full');
    expect(typeof out.classifyMs).toBe('number');
  });

  it('full verdict → fallthrough with routeVerdict full, lite never called', async () => {
    callLightweightLLM.mockResolvedValue('{"route":"full"}');
    const out = await decideCheapPath({ ...base, text: 'writ150 选哪个 prof' });
    expect(out).toMatchObject({ kind: 'fallthrough', routeVerdict: 'full' });
    expect(fastReply).not.toHaveBeenCalled();
  });

  it('images → fallthrough full without classifying', async () => {
    const out = await decideCheapPath({ ...base, hasImages: true });
    expect(out).toMatchObject({ kind: 'fallthrough', routeVerdict: 'full' });
    expect(callLightweightLLM).not.toHaveBeenCalled();
    expect(fastReply).not.toHaveBeenCalled();
  });

  it('classifier error → leans full → fallthrough', async () => {
    callLightweightLLM.mockRejectedValue(new Error('down'));
    const out = await decideCheapPath({ ...base });
    expect(out).toMatchObject({ kind: 'fallthrough', routeVerdict: 'full' });
    expect(fastReply).not.toHaveBeenCalled();
  });
});
