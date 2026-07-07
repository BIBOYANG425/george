// tests/agent/history-prefix.test.ts
// buildHistoryPrefix de-dupes the just-saved live user turn. The default paths
// (/chat, /chat/stream, Path B, spectrum non-burst) persist the user turn BEFORE
// running the orchestrator, so it reloads as the LAST history row while the live
// prompt (`${historyPrefix}${text}`) appends the same text again — a duplicate.
// The prefix must drop that LAST user row when it equals the live text, and ONLY
// the last row (an older identical message is real history, kept).
import { describe, it, expect } from 'vitest';
import { buildHistoryPrefix } from '../../src/agent/orchestrator.js';
import type { SessionStore, Message } from '../../src/agent/session-store.js';

function store(messages: Message[]): SessionStore {
  return {
    load: async () => ({ sessionId: 'u', messages, systemContext: {} }),
    save: async () => {},
    countUserMessages: async () => messages.filter((m) => m.role === 'user').length,
  } as unknown as SessionStore;
}

const m = (role: Message['role'], content: string): Message => ({ role, content });

describe('buildHistoryPrefix — live-turn dedup', () => {
  it('drops the last user row when it equals the live prompt text', async () => {
    const s = store([
      m('user', 'first question'),
      m('assistant', 'first answer'),
      m('user', 'hello 学长'), // <- the just-saved live row
    ]);
    const out = await buildHistoryPrefix(s, 'u', 'hello 学长');
    expect(out).toContain('[user]: first question');
    expect(out).toContain('[assistant]: first answer');
    // The live turn must NOT appear inside the history block (it's appended
    // separately as the live prompt by the caller).
    expect(out).not.toContain('[user]: hello 学长');
  });

  it('keeps an OLDER identical message — only the LAST row is dropped', async () => {
    const s = store([
      m('user', 'hello 学长'), // older, identical text — real history, keep
      m('assistant', 'hihi'),
      m('user', 'hello 学长'), // the just-saved live row — drop
    ]);
    const out = await buildHistoryPrefix(s, 'u', 'hello 学长');
    // Exactly ONE occurrence of the older identical user line survives.
    const occurrences = out.split('[user]: hello 学长').length - 1;
    expect(occurrences).toBe(1);
    expect(out).toContain('[assistant]: hihi');
  });

  it('does NOT drop when the last row is an assistant turn (burst-guard deferred-save shape)', async () => {
    const s = store([
      m('user', 'hello 学长'),
      m('assistant', 'hihi 学长在'),
    ]);
    const out = await buildHistoryPrefix(s, 'u', 'hello 学长');
    // Last row is assistant, so nothing is stripped; the earlier user line stays.
    expect(out).toContain('[user]: hello 学长');
    expect(out).toContain('[assistant]: hihi 学长在');
  });

  it('does NOT drop when the last user row differs from the live text', async () => {
    const s = store([m('user', 'a different question')]);
    const out = await buildHistoryPrefix(s, 'u', 'hello 学长');
    expect(out).toContain('[user]: a different question');
  });

  it('returns "" when dropping the only row leaves nothing', async () => {
    const s = store([m('user', 'hello 学长')]);
    const out = await buildHistoryPrefix(s, 'u', 'hello 学长');
    expect(out).toBe('');
  });

  it('no liveText → legacy behavior (nothing dropped)', async () => {
    const s = store([m('user', 'hello 学长')]);
    const out = await buildHistoryPrefix(s, 'u');
    expect(out).toContain('[user]: hello 学长');
  });

  it('no sessionStore → ""', async () => {
    expect(await buildHistoryPrefix(undefined, 'u', 'hi')).toBe('');
  });
});
