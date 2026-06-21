// tests/agent/grounded-proactive.test.ts
import { describe, it, expect } from 'vitest';
import {
  threadKey,
  extractOpenThreads,
  unraisedThreads,
  renderGroundedProactiveNote,
  type ProactiveMessage,
  type OpenThread,
} from '../../src/agent/grounded-proactive.js';

describe('threadKey', () => {
  it('is deterministic and stable across punctuation/case/whitespace', () => {
    const a = threadKey('想好选 BUAD 280 还是等下学期了吗?');
    const b = threadKey('  想好选 buad 280 还是等下学期了吗  ');
    expect(a).toBe(b);
  });

  it('produces a short slug', () => {
    const k = threadKey('did you decide on the parkside vs gateway dorm question yet for fall');
    expect(k.length).toBeLessThanOrEqual(60);
    expect(k).not.toMatch(/[?？\s]/);
  });
});

describe('extractOpenThreads', () => {
  it('flags an unanswered question george asked (last message, no user reply after)', () => {
    const messages: ProactiveMessage[] = [
      { role: 'user', content: '想找 writ150 的课' },
      { role: 'assistant', content: '你是想要轻松一点的还是评分高的 prof？' },
    ];
    const threads = extractOpenThreads(messages);
    expect(threads).toHaveLength(1);
    expect(threads[0].source).toBe('george_asked');
    expect(threads[0].gist).toContain('prof');
  });

  it('does NOT flag a george question that the user already answered', () => {
    const messages: ProactiveMessage[] = [
      { role: 'assistant', content: '你想住 parkside 还是 gateway？' },
      { role: 'user', content: 'parkside 吧' },
    ];
    const threads = extractOpenThreads(messages);
    expect(threads.some((t) => t.source === 'george_asked')).toBe(false);
  });

  it('flags a decision the user said they were mulling (chinese cue)', () => {
    const messages: ProactiveMessage[] = [
      { role: 'user', content: '我还在纠结要不要 drop 这门课' },
    ];
    const threads = extractOpenThreads(messages);
    expect(threads).toHaveLength(1);
    expect(threads[0].source).toBe('user_mulling');
  });

  it('flags a decision the user was mulling (english cue)', () => {
    const messages: ProactiveMessage[] = [
      { role: 'user', content: "I'm torn between staying in the dorm or moving off-campus" },
    ];
    const threads = extractOpenThreads(messages);
    expect(threads.some((t) => t.source === 'user_mulling')).toBe(true);
  });

  it('only inspects the most recent user message for mulling cues', () => {
    const messages: ProactiveMessage[] = [
      { role: 'user', content: '我还在纠结要不要 drop 这门课' },
      { role: 'assistant', content: '看你 deadline 吧' },
      { role: 'user', content: '好的谢谢' },
    ];
    const threads = extractOpenThreads(messages);
    expect(threads.some((t) => t.source === 'user_mulling')).toBe(false);
  });

  it('returns nothing for steady-state small talk', () => {
    const messages: ProactiveMessage[] = [
      { role: 'user', content: '在干嘛' },
      { role: 'assistant', content: '在写代码哈哈哈' },
      { role: 'user', content: '哈哈哈' },
    ];
    expect(extractOpenThreads(messages)).toHaveLength(0);
  });

  it('returns an empty array for no messages', () => {
    expect(extractOpenThreads([])).toEqual([]);
  });
});

describe('unraisedThreads', () => {
  it('filters out already-raised threads', () => {
    const threads: OpenThread[] = [
      { key: 'k1', source: 'george_asked', gist: 'a' },
      { key: 'k2', source: 'user_mulling', gist: 'b' },
    ];
    const raised = new Set(['k1']);
    const out = unraisedThreads(threads, raised);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('k2');
  });
});

describe('renderGroundedProactiveNote', () => {
  it('returns empty string when there are no threads (prompt unchanged)', () => {
    expect(renderGroundedProactiveNote([])).toBe('');
  });

  it('renders a grounded note that names the open threads', () => {
    const note = renderGroundedProactiveNote([
      { key: 'k1', source: 'george_asked', gist: 'which writ150 prof do you want' },
    ]);
    expect(note).toContain('# OPEN THREADS');
    expect(note).toContain('which writ150 prof do you want');
    expect(note).toContain('you asked, no reply yet');
  });

  it('labels a user-mulled thread distinctly', () => {
    const note = renderGroundedProactiveNote([
      { key: 'k2', source: 'user_mulling', gist: 'drop the class or not' },
    ]);
    expect(note).toContain('they were mulling');
  });
});
