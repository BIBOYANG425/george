// tests/adapters/spectrum-stages.test.ts
//
// Unit tests for the three extracted flush() timing stages. These prove each
// stage's behavior in isolation (the spectrum.test.ts integration tests prove
// flush() composes them with no behavior change). Covers: stageReadReceiptDelay
// default-off no-op, stageGenerate typing + interim nudge + clearTimeout on
// success/throw, stageSend 600ms pacing + abort-skip + MAX_PARTS split.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stageReadReceiptDelay,
  stageGenerate,
  stageSend,
  pickStillThinking,
  STILL_THINKING,
} from '../../src/adapters/spectrum-stages.js';
import type { ReplyHandle } from '../../src/adapters/spectrum-client.js';

function fakeReply() {
  const sent: string[] = [];
  const typing: string[] = [];
  const reply: ReplyHandle = {
    sendText: async (t) => { sent.push(t); },
    sendAttachment: async () => {},
    startTyping: async () => { typing.push('start'); },
    stopTyping: async () => { typing.push('stop'); },
  };
  return { reply, sent, typing };
}

const RR_FLAG = 'GEORGE_READRECEIPT_DELAY_ENABLED';

describe('stageReadReceiptDelay', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env[RR_FLAG]; });
  afterEach(() => {
    if (prev === undefined) delete process.env[RR_FLAG];
    else process.env[RR_FLAG] = prev;
  });

  it('is a no-op (returns immediately) when the flag is OFF, even with ms>0', async () => {
    delete process.env[RR_FLAG];
    const t0 = Date.now();
    await stageReadReceiptDelay({ readReceiptDelayMs: 500 });
    expect(Date.now() - t0).toBeLessThan(50); // did not sleep
  });

  it('is a no-op when the flag is ON but ms is 0/unset', async () => {
    process.env[RR_FLAG] = 'true';
    const t0 = Date.now();
    await stageReadReceiptDelay({ readReceiptDelayMs: 0 });
    expect(Date.now() - t0).toBeLessThan(50);
    await stageReadReceiptDelay({}); // unset
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('sleeps the configured ms when the flag is ON and ms>0', async () => {
    process.env[RR_FLAG] = 'true';
    const t0 = Date.now();
    await stageReadReceiptDelay({ readReceiptDelayMs: 40 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });
});

describe('pickStillThinking', () => {
  it('returns one of the configured nudges', () => {
    expect(STILL_THINKING).toContain(pickStillThinking());
  });
});

describe('stageGenerate', () => {
  it('starts typing, awaits handleText, and returns its output', async () => {
    const { reply, typing } = fakeReply();
    const ac = new AbortController();
    const handle = vi.fn(async () => 'the reply');
    const out = await stageGenerate('s1', ['hi'], reply, ac, handle, '', { interimDelayMs: 60_000 });
    expect(out).toBe('the reply');
    expect(typing).toContain('start');
    expect(handle).toHaveBeenCalledWith('s1', 'hi', reply, ac, '');
  });

  it('joins multiple buffered texts with a newline', async () => {
    const { reply } = fakeReply();
    const ac = new AbortController();
    const handle = vi.fn(async () => 'ok');
    await stageGenerate('s1', ['first', 'second'], reply, ac, handle, '', { interimDelayMs: 60_000 });
    expect(handle.mock.calls[0][1]).toBe('first\nsecond');
  });

  it('forwards delayContext as the 5th handleText arg', async () => {
    const { reply } = fakeReply();
    const ac = new AbortController();
    const handle = vi.fn(async () => 'ok');
    await stageGenerate('s1', ['hi'], reply, ac, handle, 'GAP NOTE', { interimDelayMs: 60_000 });
    expect(handle.mock.calls[0][4]).toBe('GAP NOTE');
  });

  it('fires one interim "still thinking" nudge when the turn runs long', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    const handle = async () => { await new Promise((r) => setTimeout(r, 30)); return 'real'; };
    const out = await stageGenerate('s1', ['hi'], reply, ac, handle, '', { interimDelayMs: 0 });
    expect(out).toBe('real');
    expect(sent).toHaveLength(1);
    expect(STILL_THINKING).toContain(sent[0]);
  });

  it('does NOT fire the nudge for a fast turn (timer cleared on success)', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    const out = await stageGenerate('s1', ['hi'], reply, ac, async () => 'quick', '', { interimDelayMs: 50 });
    expect(out).toBe('quick');
    // Give the (cleared) timer a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0);
  });

  it('does NOT fire the nudge when the turn is already aborted', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    ac.abort();
    await stageGenerate('s1', ['hi'], reply, ac, async () => { await new Promise((r) => setTimeout(r, 20)); return 'x'; }, '', { interimDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toHaveLength(0);
  });

  it('clears the interim timer and rethrows on a handleText throw (no leaked nudge)', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    await expect(
      stageGenerate('s1', ['hi'], reply, ac, async () => { throw new Error('boom'); }, '', { interimDelayMs: 10 }),
    ).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toHaveLength(0); // timer was cleared in finally
  });

  it('tolerates a failing startTyping (best-effort)', async () => {
    const sent: string[] = [];
    const reply: ReplyHandle = {
      sendText: async (t) => { sent.push(t); },
      sendAttachment: async () => {},
      startTyping: async () => { throw new Error('typing api down'); },
      stopTyping: async () => {},
    };
    const ac = new AbortController();
    const out = await stageGenerate('s1', ['hi'], reply, ac, async () => 'ok', '', { interimDelayMs: 60_000 });
    expect(out).toBe('ok');
  });
});

describe('stageSend', () => {
  it('sends a single bubble with no inter-message delay', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    await stageSend('just one line', reply, ac);
    expect(sent).toEqual(['just one line']);
  });

  it('splits on blank-line boundaries into separate bubbles', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    await stageSend('line one\n\nline two', reply, ac, { interMessageDelayMs: 0 });
    expect(sent).toEqual(['line one', 'line two']);
  });

  it('caps at MAX_PARTS=4 (overflow merged into the last bubble)', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    await stageSend('a\n\nb\n\nc\n\nd\n\ne', reply, ac, { interMessageDelayMs: 0 });
    expect(sent).toHaveLength(4);
    expect(sent[3]).toContain('d');
    expect(sent[3]).toContain('e');
  });

  it('applies the inter-message delay between bubbles (default 600ms)', async () => {
    const { reply } = fakeReply();
    const ac = new AbortController();
    const t0 = Date.now();
    await stageSend('one\n\ntwo', reply, ac); // default 600ms pacing between the 2 bubbles
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  });

  it('sends nothing when the turn was aborted', async () => {
    const { reply, sent } = fakeReply();
    const ac = new AbortController();
    ac.abort();
    await stageSend('should not send', reply, ac);
    expect(sent).toEqual([]);
  });
});
