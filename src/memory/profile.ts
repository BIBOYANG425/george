// src/memory/profile.ts
// Per-user 6-block profile load/save with KV cache.

import { KVCache } from './kv-cache.js';

export const BLOCK_NAMES = [
  'identity',
  'academic',
  'interests',
  'relationships',
  'state',
  'george_notes',
] as const;

export type BlockName = (typeof BLOCK_NAMES)[number];

export interface Profile {
  identity: string;
  academic: string;
  interests: string;
  relationships: string;
  state: string;
  george_notes: string;
}

export const EMPTY_PROFILE: Profile = {
  identity: '',
  academic: '',
  interests: '',
  relationships: '',
  state: '',
  george_notes: '',
};

export interface ProfileDB {
  loadRow(userId: string): Promise<Record<string, string> | null>;
  upsertBlock(userId: string, block: BlockName, content: string): Promise<void>;
}

const CACHE_TTL_SECONDS = 300;
const MAX_BLOCK_CHARS = 2000;

export class ProfileStore {
  constructor(private db: ProfileDB, private cache: KVCache) {}

  cacheKey(userId: string): string {
    return `user:${userId}:profile`;
  }

  async loadProfile(userId: string): Promise<Profile> {
    const cached = await this.cache.get(this.cacheKey(userId));
    if (cached) {
      return JSON.parse(cached) as Profile;
    }
    const row = await this.db.loadRow(userId);
    const profile: Profile = row
      ? {
          identity: row.identity ?? '',
          academic: row.academic ?? '',
          interests: row.interests ?? '',
          relationships: row.relationships ?? '',
          state: row.state ?? '',
          george_notes: row.george_notes ?? '',
        }
      : { ...EMPTY_PROFILE };
    await this.cache.set(this.cacheKey(userId), JSON.stringify(profile), CACHE_TTL_SECONDS);
    return profile;
  }

  async saveBlock(userId: string, block: BlockName, content: string): Promise<void> {
    if (!BLOCK_NAMES.includes(block)) {
      throw new Error(`Invalid block name: ${block}`);
    }
    if (content.length > MAX_BLOCK_CHARS) {
      throw new Error(`Block content too long (${content.length} > ${MAX_BLOCK_CHARS})`);
    }
    await this.db.upsertBlock(userId, block, content);
    await this.cache.delete(this.cacheKey(userId));
  }

  renderForPrompt(profile: Profile): string {
    const sections = BLOCK_NAMES.map((name) => {
      const content = profile[name];
      const label = name.toUpperCase().replace('_', ' ');
      return `## ${label}\n${content || '(empty)'}`;
    });
    return `# USER PROFILE\n\n${sections.join('\n\n')}`;
  }
}

import { createServiceRoleClient } from './supabase-client.js';

export function createSupabaseProfileDB(): ProfileDB {
  const supabase = createServiceRoleClient();
  return {
    async loadRow(userId) {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`loadRow failed: ${error.message}`);
      return data;
    },
    async upsertBlock(userId, block, content) {
      const { error } = await supabase
        .from('user_profiles')
        .upsert({ user_id: userId, [block]: content, updated_at: new Date().toISOString() });
      if (error) throw new Error(`upsertBlock failed: ${error.message}`);
    },
  };
}
