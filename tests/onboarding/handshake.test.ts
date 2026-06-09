// tests/onboarding/handshake.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractCodeFromStartMessage, runHandshake } from '../../src/onboarding/handshake.js';

describe('extractCodeFromStartMessage', () => {
  it('extracts code from natural prefill "i\'m ready to try george (g7k2m4)"', () => {
    expect(extractCodeFromStartMessage("i'm ready to try george (g7k2m4)")).toBe('g7k2m4');
  });
  it('extracts code from legacy "g7k2m4-START"', () => {
    expect(extractCodeFromStartMessage('g7k2m4-START')).toBe('g7k2m4');
  });
  it('trims whitespace', () => {
    expect(extractCodeFromStartMessage('  g7k2m4-START\n')).toBe('g7k2m4');
  });
  it('returns null when no handshake pattern', () => {
    expect(extractCodeFromStartMessage('hello')).toBeNull();
  });
  it('returns null for casual message with parens but no "george"', () => {
    expect(extractCodeFromStartMessage('check out (g7k2m4) it is cool')).toBeNull();
  });
  it('returns null for malformed legacy code', () => {
    expect(extractCodeFromStartMessage('SHORT-START')).toBeNull();
  });
});

describe('runHandshake', () => {
  it('sends 3 messages (greeting+vcf, intro+carousel, profile link)', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const lookup = vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' }));
    const linkHandle = vi.fn(async () => {});
    await runHandshake({
      code: 'g7k2m4',
      imessageHandle: '+15551234567',
      sendImessage: send,
      lookupPending: lookup,
      linkImessageHandle: linkHandle,
      profileUrlBase: 'https://uscbia.com/george/profile',
    });
    expect(sent.length).toBe(3);
    expect(sent[0].filePaths).toHaveLength(1); // vcf
    expect(sent[1].imagePaths).toHaveLength(5); // showcase carousel
    expect(sent[2].text).toMatch(/ready to set up/i); // profile link
    expect(linkHandle).toHaveBeenCalledWith('g7k2m4', '+15551234567');
  });

  it('refuses unknown code', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const lookup = vi.fn(async () => null);
    await runHandshake({
      code: 'badcod',
      imessageHandle: '+15551234567',
      sendImessage: send,
      lookupPending: lookup,
      linkImessageHandle: vi.fn(),
      profileUrlBase: 'https://uscbia.com/george/profile',
    });
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/couldn't find/i);
  });
});
