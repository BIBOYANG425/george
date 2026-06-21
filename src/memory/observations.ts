// src/memory/observations.ts
// P6 observation-store seam. The DB seam that Observer/Recall/Reflector use for
// the `user_observations` table (prod schema from bia-admin migration
// 20260621130000_p6_user_observations.sql). Mirrors the seam+factory style of
// profile.ts: an ObservationDB interface + a createSupabaseObservationDB()
// factory that builds the real service-role client. Tests inject a fake client
// via the internal createObservationDB(client) factory.

import { createServiceRoleClient } from './supabase-client.js';

export interface Observation {
  content: string;
  salience: number;
  kind?: string;
}

export interface RecalledObservation {
  id: number;
  content: string;
  salience: number;
  kind: string | null;
  created_at: string;
  score: number;
}

export interface UnconsolidatedObservation {
  id: number;
  content: string;
  salience: number;
  kind: string | null;
  created_at: string;
}

export interface ObservationDB {
  insert(userId: string, obs: Observation, embedding: number[] | null): Promise<void>;
  recall(
    userId: string,
    queryEmbedding: number[],
    matchCount: number,
    minSalience: number,
  ): Promise<RecalledObservation[]>;
  loadUnconsolidated(
    userId: string,
    minSalience: number,
    limit: number,
  ): Promise<UnconsolidatedObservation[]>;
  markConsolidated(ids: number[]): Promise<void>;
  // Delete rows where (consolidated_at is not null OR salience <= 1) AND
  // created_at < now() - pruneDays. Returns the deleted count.
  prune(userId: string, pruneDays: number): Promise<number>;
  deleteForUser(userId: string): Promise<void>;
}

// Minimal structural type for the slice of the Supabase client we touch. Lets
// tests inject a thin chainable stub without dragging in the full SDK type.
type SupabaseLike = ReturnType<typeof createServiceRoleClient>;

const DAY_MS = 86_400_000;

// Internal factory — takes an injected client so tests can pass a fake. The
// public createSupabaseObservationDB() calls this with the real client.
export function createObservationDB(supabase: SupabaseLike): ObservationDB {
  return {
    async insert(userId, obs, embedding) {
      const { error } = await supabase.from('user_observations').insert({
        user_id: userId,
        content: obs.content,
        embedding,
        salience: obs.salience,
        kind: obs.kind ?? null,
      });
      if (error) throw new Error(`insert observation failed: ${error.message}`);
    },

    async recall(userId, queryEmbedding, matchCount, minSalience) {
      const { data, error } = await supabase.rpc('recall_observations', {
        p_user_id: userId,
        p_query_embedding: queryEmbedding,
        p_match_count: matchCount,
        p_min_salience: minSalience,
      });
      if (error) throw new Error(`recall observations failed: ${error.message}`);
      return (data ?? []) as RecalledObservation[];
    },

    async loadUnconsolidated(userId, minSalience, limit) {
      const { data, error } = await supabase
        .from('user_observations')
        .select('id, content, salience, kind, created_at')
        .eq('user_id', userId)
        .is('consolidated_at', null)
        .gte('salience', minSalience)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`loadUnconsolidated failed: ${error.message}`);
      return (data ?? []) as UnconsolidatedObservation[];
    },

    async markConsolidated(ids) {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from('user_observations')
        .update({ consolidated_at: new Date().toISOString() })
        .in('id', ids);
      if (error) throw new Error(`markConsolidated failed: ${error.message}`);
    },

    async prune(userId, pruneDays) {
      const cutoff = new Date(Date.now() - pruneDays * DAY_MS).toISOString();
      const { count, error } = await supabase
        .from('user_observations')
        .delete({ count: 'exact' })
        .eq('user_id', userId)
        .lt('created_at', cutoff)
        // OR-of-different-columns: keep recent salient rows that George still
        // wants; only prune consolidated rows or near-noise (salience <= 1).
        .or('consolidated_at.not.is.null,salience.lte.1');
      if (error) throw new Error(`prune observations failed: ${error.message}`);
      return count ?? 0;
    },

    async deleteForUser(userId) {
      const { error } = await supabase
        .from('user_observations')
        .delete()
        .eq('user_id', userId);
      if (error) throw new Error(`deleteForUser observations failed: ${error.message}`);
    },
  };
}

export function createSupabaseObservationDB(): ObservationDB {
  return createObservationDB(createServiceRoleClient());
}

// Best-effort embedding via the Supabase `embed` Edge Function (same pattern as
// create-squad-post.ts). Returns the 1536-dim vector or null on any failure, so
// callers can insert observations without an embedding rather than dropping them.
// `client` defaults to the real service-role client; tests inject a fake.
export async function embedObservation(
  text: string,
  client: SupabaseLike = createServiceRoleClient(),
): Promise<number[] | null> {
  try {
    const { data, error } = await client.functions.invoke('embed', {
      body: { texts: [text] },
    });
    if (error) return null;
    const embedding = (data as { embeddings?: unknown[] } | null)?.embeddings?.[0];
    if (!Array.isArray(embedding)) return null;
    return embedding as number[];
  } catch {
    return null;
  }
}
