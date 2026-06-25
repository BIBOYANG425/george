// tests/admin/crisis.test.ts
// The crisis detector is the highest-stakes heuristic in the dashboard, so it lives
// or dies by this curated corpus. Two iron requirements (from the plan's PR-3 gate):
//   - genuine distress / ideation MUST trigger (a miss = a student unseen);
//   - casual "X死了" hyperbole MUST NOT trigger (false positives = alarm fatigue).
import { describe, it, expect, afterEach } from 'vitest';
import { distressSignals, crisisRadarEnabled } from '../../src/admin/crisis';

describe('distressSignals — MUST trigger on genuine distress', () => {
  it.each([
    ['我最近真的不想活了', 'suicidal_zh'],
    ['感觉活不下去了，每天都很痛苦', 'suicidal_zh'],
    ['有时候想结束自己的生命', 'suicidal_zh'],
    ['活着没意义', 'suicidal_zh'],
    ['我想自杀', 'suicidal_zh'],
    ['撑不下去了，没人在乎我', 'selfharm_zh'],
    ['I want to kill myself', 'suicidal_en'],
    ["I don't want to live anymore", 'suicidal_en'],
    ['been thinking about ending my life', 'suicidal_en'],
    ['i feel suicidal lately', 'suicidal_en'],
  ])('triggers on %s', (text, sig) => {
    expect(distressSignals(text)).toContain(sig);
  });
});

describe('distressSignals — MUST NOT trigger on hyperbole / normal stress', () => {
  it.each([
    '被这门课搞死了', // the plan's canonical false positive
    '饿死了，想吃火锅',
    '今天累死了，睡了',
    '哈哈哈哈笑死',
    '困死了要睡了',
    '热死了这天气',
    '烦死了这个 bug',
    '累得想死，明天还有 due', // intensifier "得想死", NOT ideation
    "i'm dying to see the new movie",
    'this midterm is killing me',
    'dead tired after practice',
    'CSCI 270 的 due 快把我整死了', // course stress, hyperbole
    '好无聊啊今天',
  ])('stays silent on %s', (text) => {
    expect(distressSignals(text)).toEqual([]);
  });
});

describe('distressSignals — edge cases', () => {
  it('returns [] for empty/whitespace', () => {
    expect(distressSignals('')).toEqual([]);
    expect(distressSignals('   ')).toEqual([]);
  });
  it('still catches real distress even when hyperbole is in the same message', () => {
    // "累死了" is hyperbole, but "不想活了" is real — the real signal must survive.
    expect(distressSignals('今天累死了……说真的有点不想活了')).toContain('suicidal_zh');
  });
});

describe('crisisRadarEnabled — default OFF (SOP gate)', () => {
  const prev = process.env.GEORGE_CRISIS_RADAR_ENABLED;
  afterEach(() => { if (prev === undefined) delete process.env.GEORGE_CRISIS_RADAR_ENABLED; else process.env.GEORGE_CRISIS_RADAR_ENABLED = prev; });
  it('is false when unset', () => { delete process.env.GEORGE_CRISIS_RADAR_ENABLED; expect(crisisRadarEnabled()).toBe(false); });
  it('is false for any value other than "true"', () => { process.env.GEORGE_CRISIS_RADAR_ENABLED = '1'; expect(crisisRadarEnabled()).toBe(false); });
  it('is true only for exactly "true"', () => { process.env.GEORGE_CRISIS_RADAR_ENABLED = 'true'; expect(crisisRadarEnabled()).toBe(true); });
});
