// src/memory/kv-cache.ts
// Cloudflare KV adapter with in-memory fallback for local dev + tests.

export interface KVCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface InMemoryEntry {
  value: string;
  expiresAt: number;
}

export function createInMemoryCache(): KVCache {
  const store = new Map<string, InMemoryEntry>();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export function createCloudflareKVCache(opts: {
  namespaceId: string;
  apiToken: string;
  accountId: string;
}): KVCache {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/storage/kv/namespaces/${opts.namespaceId}`;
  const headers = { Authorization: `Bearer ${opts.apiToken}` };

  return {
    async get(key) {
      const res = await fetch(`${baseUrl}/values/${encodeURIComponent(key)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`KV get failed: ${res.status}`);
      return res.text();
    },
    async set(key, value, ttlSeconds) {
      const url = `${baseUrl}/values/${encodeURIComponent(key)}?expiration_ttl=${ttlSeconds}`;
      const res = await fetch(url, { method: 'PUT', headers, body: value });
      if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
    },
    async delete(key) {
      const res = await fetch(`${baseUrl}/values/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok && res.status !== 404) throw new Error(`KV delete failed: ${res.status}`);
    },
  };
}

export function getKVCache(): KVCache {
  const namespaceId = process.env.KV_NAMESPACE_ID;
  const apiToken = process.env.KV_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (namespaceId && apiToken && accountId) {
    return createCloudflareKVCache({ namespaceId, apiToken, accountId });
  }
  return createInMemoryCache();
}
