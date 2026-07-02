// tests/agent/voice-guard-sanitize.test.ts
//
// sanitizeDashes: the code-level em/en-dash rewrite applied at the
// parseControlTokens choke point (prompt ban alone measured leaking in ~35% of
// sim conversations, both architectures). Characterizes every replacement
// context + the end-to-end path through parseControlTokens.
//
// Header last reviewed: 2026-07-02

import { describe, expect, it } from 'vitest';
import { sanitizeDashes, stripSourcesFooter, bannedVoiceHits } from '../../src/agent/voice-guard.js';
import { parseControlTokens } from '../../src/adapters/split-response.js';
import { stripMarkdown } from '../../src/adapters/strip-markdown.js';

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

describe('stripSourcesFooter', () => {
  it('removes a terminal Sources block with links', () => {
    const s = 'lyon暑假周末10am-2pm 别扑空\n\nSources:\n- [USC Rec Sports](https://recsports.usc.edu/hours)\n- https://usc.edu';
    expect(stripSourcesFooter(s)).toBe('lyon暑假周末10am-2pm 别扑空');
  });
  it('removes the degenerate emoji + "Sources:" stamp', () => {
    expect(stripSourcesFooter('冲！🫡\n\nSources:')).toBe('冲！🫡');
    expect(stripSourcesFooter('👍\n\nSources:\n- No sources needed for this response.')).toBe('👍');
  });
  it('removes 来源/参考 footers too', () => {
    expect(stripSourcesFooter('图书馆到12点\n来源: usc官网')).toBe('图书馆到12点');
    expect(stripSourcesFooter('八月开学\n参考资料：\n- 官网')).toBe('八月开学');
  });
  it('removes bare-URL-only lines anywhere', () => {
    expect(stripSourcesFooter('看这个\nhttps://libcal.usc.edu\n约个位置')).toBe('看这个\n约个位置');
  });
  it('leaves clean text alone', () => {
    const s = 'k-town 性价比之王\n\n想整顿好的就冲那';
    expect(stripSourcesFooter(s)).toBe(s);
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

  it('markdown links become labels; footers vanish (the slim search-dump case)', () => {
    const raw = '周末是10am-2pm 挺短的\n查过了 [USC Rec Sports](https://recsports.usc.edu) 官网说的\n\nSources:\n- [hours](https://recsports.usc.edu/hours)';
    const r = parseControlTokens(raw);
    expect(r.text).toBe('周末是10am-2pm 挺短的\n查过了 USC Rec Sports 官网说的');
    expect(r.text).not.toMatch(/https?:\/\//);
  });

  it('full gauntlet: footer + md-link + em-dash + NO_REPLY in one reply', () => {
    const raw = '真的不错—去试试 [libcal](https://libcal.usc.edu) {{NO_REPLY}}\n\nSources:\n- x';
    const r = parseControlTokens(raw);
    expect(r.noReply).toBe(true);
    expect(r.text).toBe('真的不错，去试试 libcal');
  });
});

describe('stripMarkdown link handling', () => {
  it('converts links and images to their labels', () => {
    expect(stripMarkdown('check [libcal](https://libcal.usc.edu) and ![map](https://x/map.png)')).toBe('check libcal and map');
  });
});
