// tests/agent/router-classify.test.ts
//
// Front-line router classifier (GEORGE_ROUTER_ENABLED). Pins parseVerdict's
// tolerant-JSON + regex + lean-full parsing, and classifyRoute's contract: it calls
// the lightweight tier with the router prompt, returns the verdict, and — critically
// — LEANS FULL on malformed output, timeout, and error (a wrong 'general' ships an
// ungrounded answer; a wrong 'full' only costs a few seconds).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { callLightweightLLM } = vi.hoisted(() => ({ callLightweightLLM: vi.fn() }));
vi.mock('../../src/agent/llm-providers.js', () => ({ callLightweightLLM }));
// fast-path is mocked so importing router.ts doesn't drag in the persona/prompt
// stack; NEEDS_AGENT must be present (router.ts uses it to build LITE_INSTRUCTION).
vi.mock('../../src/agent/fast-path.js', () => ({ fastReply: vi.fn(), NEEDS_AGENT: 'NEEDS_AGENT' }));
vi.mock('../../src/observability/logger.js', () => ({ log: vi.fn() }));

import { classifyRoute, parseVerdict } from '../../src/agent/router.js';

describe('parseVerdict — tolerant + lean-full', () => {
  it('parses clean JSON verdicts', () => {
    expect(parseVerdict('{"route":"general"}')).toBe('general');
    expect(parseVerdict('{"route":"full"}')).toBe('full');
  });

  it('tolerates prose / whitespace around the JSON', () => {
    expect(parseVerdict('Sure: {"route":"general"} done')).toBe('general');
    expect(parseVerdict('\n\n {"route" : "general"}  ')).toBe('general');
  });

  it('bare-word fallback when there is no JSON', () => {
    expect(parseVerdict('general')).toBe('general');
    expect(parseVerdict('full')).toBe('full');
    expect(parseVerdict('I think general')).toBe('general');
  });

  it('leans full on empty, unknown, or ambiguous output', () => {
    expect(parseVerdict('')).toBe('full');
    expect(parseVerdict('   ')).toBe('full');
    expect(parseVerdict('{"route":"banana"}')).toBe('full');
    expect(parseVerdict('general or full?')).toBe('full'); // both words → full
    expect(parseVerdict('{"nope":true}')).toBe('full');
  });
});

describe('classifyRoute', () => {
  let savedTimeout: string | undefined;
  beforeEach(() => {
    savedTimeout = process.env.GEORGE_ROUTER_TIMEOUT_MS;
    delete process.env.GEORGE_ROUTER_TIMEOUT_MS;
    callLightweightLLM.mockReset();
  });
  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.GEORGE_ROUTER_TIMEOUT_MS;
    else process.env.GEORGE_ROUTER_TIMEOUT_MS = savedTimeout;
  });

  it('calls the lightweight tier with the router prompt + jsonMode and returns the verdict', async () => {
    callLightweightLLM.mockResolvedValue('{"route":"general"}');
    const { verdict, classifyMs } = await classifyRoute({ text: 'explain closures', historyPrefix: '' });
    expect(verdict).toBe('general');
    expect(typeof classifyMs).toBe('number');
    const [messages, opts] = callLightweightLLM.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'explain closures' });
    expect(opts).toMatchObject({ maxTokens: 24, jsonMode: true });
  });

  it('prepends the history prefix to the user turn', async () => {
    callLightweightLLM.mockResolvedValue('{"route":"full"}');
    await classifyRoute({ text: 'writ150 选哪个', historyPrefix: 'PREV\n' });
    expect(callLightweightLLM.mock.calls[0][0][1].content).toBe('PREV\nwrit150 选哪个');
  });

  it('leans full when the model returns junk', async () => {
    callLightweightLLM.mockResolvedValue('¯\\_(ツ)_/¯');
    expect((await classifyRoute({ text: 'x', historyPrefix: '' })).verdict).toBe('full');
  });

  it('leans full when the call throws', async () => {
    callLightweightLLM.mockRejectedValue(new Error('provider down'));
    expect((await classifyRoute({ text: 'x', historyPrefix: '' })).verdict).toBe('full');
  });

  it('leans full when the call exceeds the timeout', async () => {
    process.env.GEORGE_ROUTER_TIMEOUT_MS = '10';
    callLightweightLLM.mockReturnValue(new Promise(() => {})); // never resolves
    const { verdict } = await classifyRoute({ text: 'x', historyPrefix: '' });
    expect(verdict).toBe('full');
  });
});
