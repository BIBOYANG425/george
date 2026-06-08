// src/memory/instructions.ts
// Per-user standing instructions (HEARTBEAT.md equivalent) with KV cache.

import { KVCache } from './kv-cache.js';
import { createServiceRoleClient } from './supabase-client.js';

const CACHE_TTL_SECONDS = 300;
const MAX_CONTENT_CHARS = 10000;

export interface InstructionsDB {
  load(userId: string): Promise<string | null>;
  save(userId: string, content: string): Promise<void>;
}

export class InstructionsStore {
  constructor(private db: InstructionsDB, private cache: KVCache) {}

  cacheKey(userId: string): string {
    return `user:${userId}:instructions`;
  }

  async load(userId: string): Promise<string> {
    const cached = await this.cache.get(this.cacheKey(userId));
    if (cached !== null) return cached;
    const content = (await this.db.load(userId)) ?? '';
    await this.cache.set(this.cacheKey(userId), content, CACHE_TTL_SECONDS);
    return content;
  }

  async save(userId: string, content: string): Promise<void> {
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(`Instructions content too long (${content.length} > ${MAX_CONTENT_CHARS})`);
    }
    await this.db.save(userId, content);
    await this.cache.delete(this.cacheKey(userId));
  }
}

export function createSupabaseInstructionsDB(): InstructionsDB {
  const supabase = createServiceRoleClient();
  return {
    async load(userId) {
      const { data, error } = await supabase
        .from('user_heartbeat_instructions')
        .select('content')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`instructions load failed: ${error.message}`);
      return data?.content ?? null;
    },
    async save(userId, content) {
      const { error } = await supabase.from('user_heartbeat_instructions').upsert({
        user_id: userId,
        content,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(`instructions save failed: ${error.message}`);
    },
  };
}
