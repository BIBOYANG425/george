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
  // Free-form prose relationship note (P3). Lives in its own user_profiles
  // column; loadProfile reads it here and readers use it directly (george_notes
  // is now a pure scratchpad — no fenced blob, no fallback).
  relationship_note: string;
  // Compaction marker (P1 memory-consolidation). The atomic append RPC sets this
  // to now() instead of slicing when a block would exceed MAX_BLOCK_CHARS; the
  // heartbeat reads it, condenses the over-cap block(s) under the cap with the
  // lightweight LLM, then clears it (clearCompactionDue). NOT a BLOCK_NAME, so it
  // is never rendered into the prompt — it is an internal scheduling flag only.
  compaction_due: string | null;
}

export const EMPTY_PROFILE: Profile = {
  identity: '',
  academic: '',
  interests: '',
  relationships: '',
  state: '',
  george_notes: '',
  relationship_note: '',
  compaction_due: null,
};

export interface ProfileDB {
  loadRow(userId: string): Promise<Record<string, string> | null>;
  upsertBlock(userId: string, block: BlockName, content: string): Promise<void>;
  saveRelationshipNote(userId: string, note: string): Promise<void>;
  // Atomically append `addition` to one block in a single DB transaction:
  // validate block name, dedupe by literal substring, append, and flag
  // compaction_due if the block exceeds the cap. Never slices. This replaces
  // the old client-side read-modify-write (a lost-update race + silent slice).
  appendBlockAtomic(userId: string, block: BlockName, addition: string): Promise<void>;
  // Clear the compaction_due marker after the heartbeat has condensed the
  // over-cap block(s) back under the cap. Set null + bump updated_at.
  clearCompactionDue(userId: string): Promise<void>;
}

const CACHE_TTL_SECONDS = 300;
// Per-block character cap. MUST match the cap in the append_to_profile_block RPC
// (Task 4): past this the RPC sets compaction_due instead of slicing, and the
// heartbeat's compactProfileIfDue condenses back under this same number.
export const MAX_BLOCK_CHARS = 4000;

// ── Free-form relationship note (P3) ───────────────────────────────────────
// A short prose note about George's relationship with this user, rewritten
// periodically by src/agent/evaluators/relationship.ts. It lives in the
// dedicated user_profiles.relationship_note column (read via
// Profile.relationship_note, written via ProfileStore.saveRelationshipNote).

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
          relationship_note: row.relationship_note ?? '',
          compaction_due: row.compaction_due ?? null,
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

  // Write the free-form relationship note to its own column (P3 promotion out of
  // the george_notes sentinel blob). Busts the cache so the next loadProfile sees
  // the new note.
  async saveRelationshipNote(userId: string, note: string): Promise<void> {
    await this.db.saveRelationshipNote(userId, note);
    await this.cache.delete(this.cacheKey(userId));
  }

  // Append a fact to a block WITHOUT clobbering existing content (saveBlock does a
  // full overwrite, which silently destroys earlier facts). Delegates to the
  // atomic `append_to_profile_block` RPC, which in one transaction validates the
  // block, dedupes by literal substring, appends, and flags compaction_due past
  // the cap (it never slices). This replaces the old client-side
  // read-modify-write, which was a lost-update race under concurrent writers and
  // silently sliced old facts. After the write we bust the cache so the next
  // loadProfile sees the new content. This is what per-turn capture + the
  // heartbeat append mode use to accumulate memory safely.
  async appendToBlock(userId: string, block: BlockName, addition: string): Promise<void> {
    if (!BLOCK_NAMES.includes(block)) {
      throw new Error(`Invalid block name: ${block}`);
    }
    const trimmed = addition.trim();
    if (!trimmed) return;
    await this.db.appendBlockAtomic(userId, block, trimmed);
    await this.cache.delete(this.cacheKey(userId));
  }

  // Clear the compaction_due marker after the heartbeat condensed the over-cap
  // block(s) back under the cap (see compactProfileIfDue in heartbeat.ts). Busts
  // the cache so the next loadProfile sees compaction_due === null.
  async clearCompactionDue(userId: string): Promise<void> {
    await this.db.clearCompactionDue(userId);
    await this.cache.delete(this.cacheKey(userId));
  }

  renderForPrompt(profile: Profile): string {
    // george_notes is a pure scratchpad now (the raised-thread ledger lives in
    // the proactive_raised_threads table, the relationship note in its own
    // column), so every block renders as-is.
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
    async saveRelationshipNote(userId, note) {
      const { error } = await supabase
        .from('user_profiles')
        .upsert({ user_id: userId, relationship_note: note, updated_at: new Date().toISOString() });
      if (error) throw new Error(`saveRelationshipNote failed: ${error.message}`);
    },
    async appendBlockAtomic(userId, block, addition) {
      const { error } = await supabase.rpc('append_to_profile_block', {
        p_user_id: userId, p_block: block, p_addition: addition,
      });
      if (error) throw new Error(`appendBlockAtomic failed: ${error.message}`);
    },
    async clearCompactionDue(userId) {
      const { error } = await supabase
        .from('user_profiles')
        .update({ compaction_due: null, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) throw new Error(`clearCompactionDue failed: ${error.message}`);
    },
  };
}
