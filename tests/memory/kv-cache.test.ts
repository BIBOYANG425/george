// tests/memory/kv-cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryCache, KVCache } from '../../src/memory/kv-cache';

describe('KVCache (in-memory adapter)', () => {
  let cache: KVCache;

  beforeEach(() => {
    cache = createInMemoryCache();
  });

  it('get returns null for missing key', async () => {
    expect(await cache.get('missing')).toBeNull();
  });

  it('set then get returns the value', async () => {
    await cache.set('k1', 'hello', 300);
    expect(await cache.get('k1')).toBe('hello');
  });

  it('delete removes the value', async () => {
    await cache.set('k1', 'hello', 300);
    await cache.delete('k1');
    expect(await cache.get('k1')).toBeNull();
  });

  it('expired value returns null', async () => {
    await cache.set('k1', 'hello', 0); // immediate expiry
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get('k1')).toBeNull();
  });
});
