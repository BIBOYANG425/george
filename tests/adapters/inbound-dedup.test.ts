// tests/adapters/inbound-dedup.test.ts
// Path B inbound dedup: (sender,text) seen-set with a short TTL and a bounded size.
// A duplicate within the window is reported so the route can 200 {deduped:true}.
import { describe, it, expect } from 'vitest';
import { InboundDedup } from '../../src/adapters/inbound-dedup.js';

describe('InboundDedup — TTL', () => {
  it('first sighting is not a duplicate; an immediate re-POST is', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ ttlMs: 120_000, now: () => now });
    expect(d.isDuplicate('+1555', 'hello 学长')).toBe(false);
    expect(d.isDuplicate('+1555', 'hello 学长')).toBe(true);
    expect(d.isDuplicate('+1555', 'hello 学长')).toBe(true);
  });

  it('a different sender or different text is not a duplicate', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ now: () => now });
    expect(d.isDuplicate('+1555', 'hi')).toBe(false);
    expect(d.isDuplicate('+1666', 'hi')).toBe(false); // different sender
    expect(d.isDuplicate('+1555', 'bye')).toBe(false); // different text
  });

  it('normalizes whitespace + case so trivial variance still dedupes', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ now: () => now });
    expect(d.isDuplicate('+1555', 'Hello  学长')).toBe(false);
    expect(d.isDuplicate('+1555', '  hello 学长 ')).toBe(true);
  });

  it('expires after the TTL — the same message runs again once the window passes', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ ttlMs: 120_000, now: () => now });
    expect(d.isDuplicate('+1555', 'hi')).toBe(false);
    now += 119_000; // still inside the window
    expect(d.isDuplicate('+1555', 'hi')).toBe(true);
    now += 2_000; // now past 120s from the first sighting
    expect(d.isDuplicate('+1555', 'hi')).toBe(false); // fresh again
  });

  it('uses a fixed window from the first sighting (a re-POST does not extend it)', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ ttlMs: 100, now: () => now });
    expect(d.isDuplicate('+1555', 'hi')).toBe(false); // expiry pinned at first sighting + 100
    now += 60;
    expect(d.isDuplicate('+1555', 'hi')).toBe(true); // still inside the window
    now += 50; // 110ms from the FIRST sighting → window elapsed, not extended
    expect(d.isDuplicate('+1555', 'hi')).toBe(false); // fresh again
  });
});

describe('InboundDedup — eviction (bounded size)', () => {
  it('never grows past maxEntries; oldest entries are evicted first', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ ttlMs: 10_000_000, maxEntries: 3, now: () => now });
    // Fill to the cap with distinct messages, each 1ms apart so ordering is stable.
    for (const t of ['a', 'b', 'c']) {
      d.isDuplicate('+1555', t);
      now += 1;
    }
    expect(d.size()).toBe(3);
    // One more distinct message evicts the oldest ('a').
    d.isDuplicate('+1555', 'd');
    expect(d.size()).toBe(3);
    // 'a' was evicted → seeing it again is NOT a duplicate (fresh insert).
    expect(d.isDuplicate('+1555', 'a')).toBe(false);
    // 'd' is still remembered.
    expect(d.isDuplicate('+1555', 'd')).toBe(true);
  });

  it('expired entries are swept lazily rather than counting toward the cap', () => {
    let now = 1_000_000;
    const d = new InboundDedup({ ttlMs: 100, maxEntries: 100, now: () => now });
    d.isDuplicate('+1555', 'old');
    expect(d.size()).toBe(1);
    now += 200; // 'old' is now expired
    d.isDuplicate('+1555', 'new'); // sweep drops 'old' before inserting 'new'
    expect(d.size()).toBe(1);
  });
});
