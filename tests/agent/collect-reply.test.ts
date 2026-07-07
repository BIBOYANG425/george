// tests/agent/collect-reply.test.ts
// Unit tests for collectOrchestratorReply — the shared reducer the five transport
// loops now use. Pins the reduction (result wins, assistant fallback, telemetry
// capture) and the hook semantics (interstitial only with text, reaction only with
// emoji, hooks omitted → events ignored).
import { describe, it, expect, vi } from 'vitest';
import { collectOrchestratorReply, type OrchestratorEvent } from '../../src/agent/collect-reply.js';

async function* stream(...events: OrchestratorEvent[]): AsyncGenerator<OrchestratorEvent> {
  for (const e of events) yield e;
}

describe('collectOrchestratorReply — reduction', () => {
  it('takes the reply from a non-empty result event', async () => {
    const { text } = await collectOrchestratorReply(stream({ type: 'result', result: 'hi 学长' }));
    expect(text).toBe('hi 学长');
  });

  it('falls back to the first assistant message text when no result arrives', async () => {
    const { text } = await collectOrchestratorReply(
      stream({ type: 'assistant', message: { content: [{ type: 'text', text: 'from ' }, { type: 'text', text: 'assistant' }] } }),
    );
    expect(text).toBe('from assistant');
  });

  it('a later assistant message does not overwrite an already-set reply', async () => {
    const { text } = await collectOrchestratorReply(
      stream(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
      ),
    );
    expect(text).toBe('first');
  });

  it('a result overrides an earlier assistant fallback', async () => {
    const { text } = await collectOrchestratorReply(
      stream(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } },
        { type: 'result', result: 'final' },
      ),
    );
    expect(text).toBe('final');
  });

  it('ignores empty result and empty assistant content → text is ""', async () => {
    const { text } = await collectOrchestratorReply(
      stream({ type: 'result', result: '' }, { type: 'assistant', message: { content: [] } }),
    );
    expect(text).toBe('');
  });

  it('captures the trailing telemetry event', async () => {
    const tel = { channel: 'imessage' as const, tools: [], outcome: 'success' };
    const { telemetry } = await collectOrchestratorReply(
      stream({ type: 'result', result: 'x' }, { type: 'telemetry', telemetry: tel }),
    );
    expect(telemetry).toBe(tel);
  });
});

describe('collectOrchestratorReply — hooks', () => {
  it('fires onInterstitial only for interstitial events carrying text', async () => {
    const onInterstitial = vi.fn();
    await collectOrchestratorReply(
      stream(
        { type: 'interstitial', text: 'checking…' },
        { type: 'interstitial' }, // no text → skipped
        { type: 'result', result: 'done' },
      ),
      { onInterstitial },
    );
    expect(onInterstitial).toHaveBeenCalledTimes(1);
    expect(onInterstitial).toHaveBeenCalledWith('checking…');
  });

  it('awaits an async onInterstitial before finishing', async () => {
    const order: string[] = [];
    await collectOrchestratorReply(
      stream({ type: 'interstitial', text: 'i' }, { type: 'result', result: 'r' }),
      { onInterstitial: async () => { await Promise.resolve(); order.push('interstitial'); } },
    );
    order.push('done');
    expect(order).toEqual(['interstitial', 'done']);
  });

  it('fires onReaction only for reaction events carrying an emoji', async () => {
    const onReaction = vi.fn();
    await collectOrchestratorReply(
      stream(
        { type: 'reaction', emoji: '👍' },
        { type: 'reaction', emoji: '' }, // empty → skipped
        { type: 'result', result: 'ok' },
      ),
      { onReaction },
    );
    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onReaction).toHaveBeenCalledWith('👍');
  });

  it('ignores interstitial and reaction events when no hooks are supplied', async () => {
    const { text } = await collectOrchestratorReply(
      stream(
        { type: 'reaction', emoji: '👍' },
        { type: 'interstitial', text: 'checking' },
        { type: 'result', result: 'reply' },
      ),
    );
    expect(text).toBe('reply');
  });

  it('propagates an error thrown mid-stream (superseded/aborted turn)', async () => {
    async function* boom(): AsyncGenerator<OrchestratorEvent> {
      yield { type: 'interstitial', text: 'x' };
      throw new Error('aborted');
    }
    await expect(collectOrchestratorReply(boom())).rejects.toThrow('aborted');
  });
});
