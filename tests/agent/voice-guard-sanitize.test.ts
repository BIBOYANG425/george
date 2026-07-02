// tests/agent/voice-guard-sanitize.test.ts
//
// sanitizeDashes: the code-level em/en-dash rewrite applied at the
// parseControlTokens choke point (prompt ban alone measured leaking in ~35% of
// sim conversations, both architectures). Characterizes every replacement
// context + the end-to-end path through parseControlTokens.
//
// Header last reviewed: 2026-07-02

import { describe, expect, it } from 'vitest';
import { sanitizeDashes, bannedVoiceHits } from '../../src/agent/voice-guard.js';
import { parseControlTokens } from '../../src/adapters/split-response.js';

describe('sanitizeDashes', () => {
  it('passes clean text through untouched', () => {
    const s = 'k-town 性价比之王 想整顿好的就冲那';
    expect(sanitizeDashes(s)).toBe(s);
  });

  it('keeps digit ranges as hyphens', () => {
    expect(sanitizeDashes('open 9—5 weekdays')).toBe('open 9-5 weekdays');
    expect(sanitizeDashes('2019–2024')).toBe('2019-2024');
  });

  it('CJK context becomes 中文 comma', () => {
    expect(sanitizeDashes('这家店不错—就是有点贵')).toBe('这家店不错，就是有点贵');
    expect(sanitizeDashes('leavey三楼—很安静')).toBe('leavey三楼，很安静');
  });

  it('spaced latin em-dash becomes comma', () => {
    expect(sanitizeDashes('k-town is solid — cheap too')).toBe('k-town is solid, cheap too');
  });

  it('unspaced latin em-dash becomes comma-space', () => {
    expect(sanitizeDashes('solid—cheap—fast')).toBe('solid, cheap, fast');
  });

  it('tidies comma-before-punctuation artifacts', () => {
    expect(sanitizeDashes('真的很好吃—。')).toBe('真的很好吃。');
  });

  it('output never contains a banned dash, on any mixed input', () => {
    const nasty = '嗯 gateway不错——贵是真的贵 – but honestly 9–5 shifts—it depends。';
    const out = sanitizeDashes(nasty);
    expect(bannedVoiceHits(out)).not.toContain('em_dash');
  });
});

describe('parseControlTokens applies the sanitizer end-to-end', () => {
  it('strips {{NO_REPLY}} and rewrites dashes in one pass', () => {
    const r = parseControlTokens('这家不错—有点贵 {{NO_REPLY}}');
    expect(r.noReply).toBe(true);
    expect(r.text).toBe('这家不错，有点贵');
  });

  it('reactive reply path emits no banned dash', () => {
    const r = parseControlTokens('leavey 3rd floor — quiet fr');
    expect(bannedVoiceHits(r.text)).toEqual([]);
    expect(r.text).toBe('leavey 3rd floor, quiet fr');
  });
});
