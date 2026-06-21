// src/memory/profile.ts
// Per-user 6-block profile load/save with KV cache.

import { KVCache } from './kv-cache.js';
import { stripRaisedThreadLines } from '../agent/grounded-proactive.js';

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
  // Free-form prose relationship note (P3). Promoted out of the george_notes
  // sentinel-fenced blob into its own user_profiles column. loadProfile reads it
  // here first; readers keep a fallback to extractRelationshipNote(george_notes)
  // until a later backfill migrates existing notes out of the blob.
  relationship_note: string;
}

export const EMPTY_PROFILE: Profile = {
  identity: '',
  academic: '',
  interests: '',
  relationships: '',
  state: '',
  george_notes: '',
  relationship_note: '',
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
}

const CACHE_TTL_SECONDS = 300;
const MAX_BLOCK_CHARS = 4000;

// ── Free-form relationship note (P3, zero-schema MVP) ──────────────────────
// A short prose note about George's relationship with this user, rewritten
// periodically by src/agent/evaluators/relationship.ts. Until a bia-admin
// migration adds a dedicated column, it lives INSIDE the george_notes block,
// fenced by sentinel markers so the evaluator can rewrite just its own portion
// without clobbering any other george_notes content (heartbeat scratchpad, P4
// raised-thread markers, etc.). Pure string helpers so they unit-test without a
// DB. The markers are HTML comments so they read as inert if ever surfaced raw.
export const REL_NOTE_START = '<!-- relationship_note:start -->';
export const REL_NOTE_END = '<!-- relationship_note:end -->';
const REL_NOTE_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(REL_NOTE_START)}[\\s\\S]*?${escapeRegExp(REL_NOTE_END)}\\n*`,
  'g',
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pull just the prose note out of a george_notes block (empty string if none).
export function extractRelationshipNote(georgeNotes: string): string {
  const start = georgeNotes.indexOf(REL_NOTE_START);
  const end = georgeNotes.indexOf(REL_NOTE_END);
  if (start === -1 || end === -1 || end < start) return '';
  return georgeNotes.slice(start + REL_NOTE_START.length, end).trim();
}

// Return a new george_notes string with the sentinel-fenced note replaced by
// `note` (any prior fenced note is stripped first, so this is idempotent and
// never accumulates). A blank note removes the fence entirely. Non-note content
// in the block is preserved verbatim.
export function upsertRelationshipNote(georgeNotes: string, note: string): string {
  const withoutNote = georgeNotes.replace(REL_NOTE_BLOCK_RE, '\n').trim();
  const trimmed = note.trim();
  if (!trimmed) return withoutNote;
  const fenced = `${REL_NOTE_START}\n${trimmed}\n${REL_NOTE_END}`;
  return withoutNote ? `${withoutNote}\n\n${fenced}` : fenced;
}

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

  renderForPrompt(profile: Profile): string {
    const sections = BLOCK_NAMES.map((name) => {
      // Hide the grounded-proactive RAISED_THREAD ledger from the heartbeat's
      // profile view; it's an internal dedupe trail, not memory about the user.
      const content = name === 'george_notes' ? stripRaisedThreadLines(profile[name]) : profile[name];
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
  };
}
