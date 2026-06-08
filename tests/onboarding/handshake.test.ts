// tests/onboarding/handshake.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractCodeFromStartMessage, runHandshake } from '../../src/onboarding/handshake.js';

describe('extractCodeFromStartMessage', () => {
  it('extracts code from "g7k2m4-START"', () => {
    expect(extractCodeFromStartMessage('g7k2m4-START')).toBe('g7k2m4');
  });
  it('trims whitespace', () => {
    expect(extractCodeFromStartMessage('  g7k2m4-START\n')).toBe('g7k2m4');
  });
  it('returns null when no -START suffix', () => {
    expect(extractCodeFromStartMessage('hello')).toBeNull();
  });
  it('returns null for malformed code', () => {
    expect(extractCodeFromStartMessage('SHORT-START')).toBeNull();
  });
});

describe('runHandshake', () => {
  it('sends 5+ messages (text, vcf, intro, 5 images, link)', async () => {
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
    expect(sent.length).toBeGreaterThanOrEqual(8); // greeting + vcf + intro + 5 images + link
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
