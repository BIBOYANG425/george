// tests/admin/fabrication.test.ts
// PR-2 fabrication sentinel — the pure heuristics behind getFabricationSuspects.
// George's domain rule: course numbers / prices / RMP ratings must come from a
// tool, never invention. A turn that STATES one with NO tool call is a suspect.
import { describe, it, expect } from 'vitest';
import { fabricationSignals, turnUsedNoTools } from '../../src/admin/analytics';

describe('fabricationSignals (specific-claim detector)', () => {
  it('flags a course-number claim', () => {
    expect(fabricationSignals('选 WRIT 150 这门，避开 BUAD 280')).toContain('course');
  });
  it('flags a price claim ($ / ¥ / 刀 / /月)', () => {
    expect(fabricationSignals('房租大概 $1200/月')).toContain('price');
    expect(fabricationSignals('一个月 3000 块差不多')).toContain('price');
    expect(fabricationSignals('¥800 就够了')).toContain('price');
  });
  it('flags an RMP-style rating claim', () => {
    expect(fabricationSignals('那个教授 rmp 4.7，挺稳的')).toContain('rating');
  });
  it('returns multiple signals when several appear', () => {
    expect(fabricationSignals('WRIT 150 那个 prof 5.0，一学期 $600').sort()).toEqual(['course', 'price', 'rating']);
  });
  it('returns nothing for chit-chat with no specific claim', () => {
    expect(fabricationSignals('哈哈哈哈好的学长，那我晚点找你')).toEqual([]);
    expect(fabricationSignals('')).toEqual([]);
  });
});

describe('turnUsedNoTools', () => {
  it('true when tool_calls has no tools (null / empty / missing array)', () => {
    expect(turnUsedNoTools(null)).toBe(true);
    expect(turnUsedNoTools({})).toBe(true);
    expect(turnUsedNoTools({ tools: [] })).toBe(true);
    expect(turnUsedNoTools({ model: 'x', tools: undefined })).toBe(true);
  });
  it('false when the turn invoked at least one tool', () => {
    expect(turnUsedNoTools({ tools: ['search_courses'] })).toBe(false);
    expect(turnUsedNoTools({ tools: ['get_course_reviews', 'travel_time'] })).toBe(false);
  });
});
