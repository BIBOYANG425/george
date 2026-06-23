// tests/onboarding/handshake.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractCodeFromStartMessage, runHandshake } from '../../src/onboarding/handshake.js';

describe('extractCodeFromStartMessage', () => {
  it('extracts code from natural prefill "i\'m ready to try george (g7k2m4)"', () => {
    expect(extractCodeFromStartMessage("i'm ready to try george (g7k2m4)")).toEqual({
      code: 'g7k2m4',
      format: 'natural',
    });
  });
  it('extracts code from legacy "g7k2m4-START"', () => {
    expect(extractCodeFromStartMessage('g7k2m4-START')).toEqual({
      code: 'g7k2m4',
      format: 'legacy',
    });
  });
  it('trims whitespace', () => {
    expect(extractCodeFromStartMessage('  g7k2m4-START\n')).toEqual({
      code: 'g7k2m4',
      format: 'legacy',
    });
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
  it('flags conversational sentences with parenthesized words as natural format', () => {
    // "senior" is 6 alphanumeric chars, so this matches the natural regex.
    // It must surface as format:'natural' so the caller can fall through to
    // the orchestrator when the lookup misses.
    expect(extractCodeFromStartMessage('can you ask george (senior) about housing')).toEqual({
      code: 'senior',
      format: 'natural',
    });
  });
});

describe('runHandshake', () => {
  const baseOpts = {
    imessageHandle: '+15551234567',
    profileUrlBase: 'https://uscbia.com/george/profile',
  };

  it('sends 3 messages (greeting+vcf, intro+carousel, profile link) and returns true', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const lookup = vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' }));
    const linkHandle = vi.fn(async () => {});
    const handled = await runHandshake({
      ...baseOpts,
      code: 'g7k2m4',
      format: 'natural',
      sendImessage: send,
      lookupPending: lookup as any,
      linkImessageHandle: linkHandle,
    });
    expect(handled).toBe(true);
    expect(sent.length).toBe(3);
    expect(sent[0].filePaths).toHaveLength(1); // vcf
    // Carousel guard: placeholder/missing images are filtered; with the current
    // stub PNGs (<1KB) message 2 degrades to text-only captions. Once real
    // assets land, imagePaths returns with up to 5 entries.
    expect(sent[1].imagePaths === undefined || sent[1].imagePaths.length <= 5).toBe(true);
    expect(sent[1].text).toMatch(/here's what I can do/i); // captions always present
    expect(sent[2].text).toMatch(/ready to set up/i); // profile link
    expect(linkHandle).toHaveBeenCalledWith('g7k2m4', '+15551234567');
  });

  it('refuses unknown legacy code with an error reply', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const handled = await runHandshake({
      ...baseOpts,
      code: 'badcod',
      format: 'legacy',
      sendImessage: send,
      lookupPending: vi.fn(async () => null),
      linkImessageHandle: vi.fn(),
    });
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/couldn't find/i);
  });

  it('returns false silently on unknown natural code so the caller falls through to the orchestrator', async () => {
    const send = vi.fn();
    const handled = await runHandshake({
      ...baseOpts,
      code: 'senior',
      format: 'natural',
      sendImessage: send,
      lookupPending: vi.fn(async () => null),
      linkImessageHandle: vi.fn(),
    });
    expect(handled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('replies "already in" for completed codes and returns true', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const handled = await runHandshake({
      ...baseOpts,
      code: 'g7k2m4',
      format: 'natural',
      sendImessage: send,
      lookupPending: vi.fn(async () => ({ code: 'g7k2m4', status: 'completed' })) as any,
      linkImessageHandle: vi.fn(),
    });
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/already in/i);
  });
});

describe('usableImagePaths (placeholder guard)', () => {
  it('filters out sub-1KB stubs and missing files', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
    const real = path.join(dir, 'real.png');
    const stub = path.join(dir, 'stub.png');
    fs.writeFileSync(real, Buffer.alloc(2048, 1));
    fs.writeFileSync(stub, Buffer.alloc(70, 1));
    const { usableImagePaths } = await import('../../src/onboarding/handshake.js');
    expect(usableImagePaths([real, stub, path.join(dir, 'missing.png')])).toEqual([real]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('markGreeted callback (by-handle funnel idempotency)', () => {
  it('stamps greeted after a successful greeting', async () => {
    const markGreeted = vi.fn(async () => {});
    await runHandshake({
      imessageHandle: '+15551234567',
      profileUrlBase: 'https://uscbia.com/george/profile',
      code: 'g7k2m4',
      format: 'natural',
      sendImessage: vi.fn(async () => {}),
      lookupPending: vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' })) as any,
      linkImessageHandle: vi.fn(),
      markGreeted,
    });
    expect(markGreeted).toHaveBeenCalledWith('g7k2m4');
  });

  it('stamps greeted AFTER message 1 succeeds, before messages 2-3 (still closes the re-greet race on the slow part)', async () => {
    const order: string[] = [];
    const markGreeted = vi.fn(async () => { order.push('mark'); });
    const sendImessage = vi.fn(async () => { order.push('send'); });
    await runHandshake({
      imessageHandle: '+15551234567',
      profileUrlBase: 'https://uscbia.com/george/profile',
      code: 'g7k2m4',
      format: 'natural',
      sendImessage,
      lookupPending: vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' })) as any,
      linkImessageHandle: vi.fn(),
      markGreeted,
    });
    // Exactly one mark, positioned after the first send and before sends 2-3.
    expect(markGreeted).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['send', 'mark', 'send', 'send']);
  });

  it('does NOT stamp greeted when the first send throws (prod bug: never silently marked greeted without delivery)', async () => {
    const markGreeted = vi.fn(async () => {});
    const linkHandle = vi.fn(async () => {});
    // Transport drops the very first send (the flaky-Spectrum prod scenario).
    const sendImessage = vi.fn(async () => { throw new Error('spectrum transport down'); });
    await expect(runHandshake({
      imessageHandle: '+15551234567',
      profileUrlBase: 'https://uscbia.com/george/profile',
      code: 'g7k2m4',
      format: 'natural',
      sendImessage,
      lookupPending: vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' })) as any,
      linkImessageHandle: linkHandle,
      markGreeted,
    })).rejects.toThrow('spectrum transport down');
    // Core fix: a failed first send must NOT mark the user greeted, so the
    // by-handle path (`!greeted_at`) re-greets them next time.
    expect(markGreeted).not.toHaveBeenCalled();
    // Handle linking still ran before message 1 (binding identity is correct
    // even when the greeting fails to send).
    expect(linkHandle).toHaveBeenCalledWith('g7k2m4', '+15551234567');
    // Only the first send was attempted before the throw.
    expect(sendImessage).toHaveBeenCalledTimes(1);
  });

  it('links the handle before message 1', async () => {
    const order: string[] = [];
    const linkHandle = vi.fn(async () => { order.push('link'); });
    const sendImessage = vi.fn(async () => { order.push('send'); });
    await runHandshake({
      imessageHandle: '+15551234567',
      profileUrlBase: 'https://uscbia.com/george/profile',
      code: 'g7k2m4',
      format: 'natural',
      sendImessage,
      lookupPending: vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' })) as any,
      linkImessageHandle: linkHandle,
      markGreeted: vi.fn(async () => {}),
    });
    expect(order[0]).toBe('link');
    expect(order.indexOf('link')).toBeLessThan(order.indexOf('send'));
  });

  it('does NOT stamp on "already in" or lookup miss', async () => {
    const markGreeted = vi.fn(async () => {});
    await runHandshake({
      imessageHandle: '+15551234567',
      profileUrlBase: 'https://uscbia.com/george/profile',
      code: 'g7k2m4',
      format: 'natural',
      sendImessage: vi.fn(async () => {}),
      lookupPending: vi.fn(async () => ({ code: 'g7k2m4', status: 'completed' })) as any,
      linkImessageHandle: vi.fn(),
      markGreeted,
    });
    await runHandshake({
      imessageHandle: '+15551234567',
      profileUrlBase: 'https://uscbia.com/george/profile',
      code: 'nocode',
      format: 'natural',
      sendImessage: vi.fn(async () => {}),
      lookupPending: vi.fn(async () => null),
      linkImessageHandle: vi.fn(),
      markGreeted,
    });
    expect(markGreeted).not.toHaveBeenCalled();
  });
});
