// tests/agent/voice-guard.test.ts
import { describe, it, expect } from 'vitest';
import { bannedVoiceHits } from '../../src/agent/voice-guard.js';

describe('bannedVoiceHits — the two hard-banned voice tells that survive the bia-lore drop', () => {
  it('flags an em-dash and an en-dash', () => {
    expect(bannedVoiceHits('那个局 — 还考虑吗')).toContain('em_dash');
    expect(bannedVoiceHits('cool – come thru')).toContain('em_dash');
  });

  it('flags the chinese negation-pivot 不是…而是', () => {
    expect(bannedVoiceHits('这不是玄学，而是科学')).toContain('negation_contrast_zh');
  });

  it('flags the english "it\'s not X, it\'s Y" pivot (comma form)', () => {
    expect(bannedVoiceHits("it's not about the money, it's about respect")).toContain('negation_contrast_en');
    expect(bannedVoiceHits("it's not luck, it is prep")).toContain('negation_contrast_en');
  });

  it('stays clean on normal chinese + english (no false positives)', () => {
    expect(bannedVoiceHits('诶 那个局还考虑吗 想去回我哈')).toEqual([]);
    expect(bannedVoiceHits('haha yeah AEPi 7pm, hot pot, you free?')).toEqual([]);
    // factual "not ready, still loading" must NOT trip the en pivot (no comma+it's)
    expect(bannedVoiceHits("it's not ready yet honestly")).toEqual([]);
  });
});
