// tests/agent/grounded-proactive.test.ts
import { describe, it, expect } from 'vitest';
import {
  threadKey,
  extractOpenThreads,
  parseRaisedThreads,
  raisedThreadLine,
  unraisedThreads,
  renderGroundedProactiveNote,
  stripRaisedThreadLines,
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

describe('raised-thread ledger (george_notes)', () => {
  it('round-trips a raised key through the ledger line', () => {
    const key = threadKey('想好选 buad 280 还是等下学期了吗');
    const line = raisedThreadLine(key);
    const parsed = parseRaisedThreads(`some other note\n${line}\nanother note`);
    expect(parsed.has(key)).toBe(true);
  });

  it('parses an empty/absent notes block to an empty set', () => {
    expect(parseRaisedThreads('').size).toBe(0);
    expect(parseRaisedThreads('just a normal note\nno markers here').size).toBe(0);
  });

  it('unraisedThreads filters out already-raised threads', () => {
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

describe('stripRaisedThreadLines (ledger never leaks into renders)', () => {
  it('returns the input UNCHANGED when there is no ledger line (byte-for-byte)', () => {
    const notes = 'promised to send the housing list\nwants a writ150 rec';
    expect(stripRaisedThreadLines(notes)).toBe(notes);
    expect(stripRaisedThreadLines('')).toBe('');
  });

  it('removes RAISED_THREAD lines but keeps the real notes', () => {
    const key = threadKey('which writ150 prof do you want');
    const notes = `promised the housing list\n${raisedThreadLine(key)}\nwants a writ150 rec`;
    const stripped = stripRaisedThreadLines(notes);
    expect(stripped).not.toContain('RAISED_THREAD');
    expect(stripped).toContain('promised the housing list');
    expect(stripped).toContain('wants a writ150 rec');
    // The stored block still parses the ledger — only the render is stripped.
    expect(parseRaisedThreads(notes).has(key)).toBe(true);
  });

  it('collapses the gap left when a ledger line sat between real notes', () => {
    const notes = `note a\n${raisedThreadLine('k1')}\n${raisedThreadLine('k2')}\nnote b`;
    expect(stripRaisedThreadLines(notes)).toBe('note a\nnote b');
  });

  it('yields empty string when the block was only ledger lines', () => {
    const notes = `${raisedThreadLine('k1')}\n${raisedThreadLine('k2')}`;
    expect(stripRaisedThreadLines(notes)).toBe('');
  });
});
