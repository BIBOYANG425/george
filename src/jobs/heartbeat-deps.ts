// src/jobs/heartbeat-deps.ts
// Factory for the HeartbeatDeps bag that runHeartbeat() consumes. This was ~100
// inline lines in index.ts; extracting it keeps the server entry readable and makes
// the heartbeat wiring importable/testable on its own.
//
// The shared singletons (profileStore, KV cache, service-role Supabase client) are
// injected so this factory reuses the ONE client/store the rest of the process
// already holds — no second Supabase client is created here. The heartbeat-only
// stores (instructions, raised-thread ledger, observation log) and the DeepSeek
// client are heartbeat-specific, so they are constructed here. `sendImessage` is the
// proactive sender (makeProactiveSender output) supplied by the caller, which knows
// the live Spectrum client and the legacy-queue fallback.
//
// Header last reviewed: 2026-07-07
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProfileStore } from '../memory/profile.js';
import type { getKVCache } from '../memory/kv-cache.js';
import type { HeartbeatDeps } from '../agent/heartbeat.js';
import { InstructionsStore, createSupabaseInstructionsDB } from '../memory/instructions.js';
import { createSupabaseObservationDB } from '../memory/observations.js';
import { createSupabaseRaisedThreadDB } from '../agent/grounded-proactive.js';
import { createDeepSeekClient } from '../agent/llm-clients.js';

export interface HeartbeatDepsConfig {
  // Shared singletons reused from the caller (no second client/store built here).
  profileStore: ProfileStore;
  cache: ReturnType<typeof getKVCache>;
  supabase: SupabaseClient;
  // Proactive-send fn (makeProactiveSender output): routes through the live Spectrum
  // client when connected, else the durable legacy imessage_outgoing queue.
  sendImessage: (msg: { to: string; text: string }) => Promise<void>;
}

export function buildHeartbeatDeps(cfg: HeartbeatDepsConfig): HeartbeatDeps {
  const { profileStore, cache, supabase, sendImessage } = cfg;
  const instructionsStore = new InstructionsStore(createSupabaseInstructionsDB(), cache);
  const llm = createDeepSeekClient();
  return {
    profileStore,
    instructionsStore,
    raisedThreadDb: createSupabaseRaisedThreadDB(),
    // P6 observational-memory — Reflector seam. Harmless when GEORGE_REFLECT_ENABLED
    // is off (the flag gates execution in runHeartbeat).
    observationDB: createSupabaseObservationDB(),
    async loadConfig(userId) {
      const { data, error } = await supabase
        .from('user_heartbeat_config')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async loadRecentMessages(userId, limit) {
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).reverse();
    },
    async loadDueFollowups(userId) {
      const { data, error } = await supabase
        .from('student_followups')
        .select('id, content, scheduled_for')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .lte('scheduled_for', new Date().toISOString());
      if (error) throw error;
      return data ?? [];
    },
    sendImessage,
    async insertFollowup(row) {
      const { error } = await supabase.from('student_followups').insert({
        user_id: row.userId,
        content: row.content,
        scheduled_for: row.scheduledFor,
      });
      if (error) throw error;
    },
    async writeLog(entry) {
      const { error } = await supabase.from('heartbeat_log').insert(entry);
      if (error) console.error('heartbeat log write failed', error);
    },
    async updateLastHeartbeatAt(userId) {
      const { error } = await supabase
        .from('user_heartbeat_config')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) throw error;
    },
    callLLM: llm.call.bind(llm),
  };
}
