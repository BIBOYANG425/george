// src/onboarding/pending-users.ts
// DB operations for pending_users (migration 015).
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PendingUser {
  code: string;
  imessage_handle: string | null;
  status: 'pending' | 'completed' | 'abandoned';
  created_at: string;
  reminded_at: string | null;
  // Set when the 3-message greeting has been sent (by code OR by handle).
  // Makes the greeting idempotent: a second "hello" before the profile form
  // completes must not re-send the carousel.
  greeted_at: string | null;
}

export async function createPendingUser(supabase: SupabaseClient, code: string): Promise<void> {
  const { error } = await supabase.from('pending_users').insert({
    code,
    status: 'pending',
  });
  if (error) throw new Error(`createPendingUser failed: ${error.message}`);
}

export async function lookupByCode(supabase: SupabaseClient, code: string): Promise<PendingUser | null> {
  const { data, error } = await supabase
    .from('pending_users')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error(`lookupByCode failed: ${error.message}`);
  return data ?? null;
}

export async function linkImessageHandle(
  supabase: SupabaseClient,
  code: string,
  imessageHandle: string
): Promise<void> {
  const { error } = await supabase
    .from('pending_users')
    .update({ imessage_handle: imessageHandle })
    .eq('code', code);
  if (error) throw new Error(`linkImessageHandle failed: ${error.message}`);
}

// Completion (status -> 'completed') is owned by the bia-roommate profile
// form (app/george/profile/api/submit/route.ts), which updates the row
// directly. This repo only reads completion state via lookupByCode.

// A user can mint multiple codes and handshake more than one, leaving several
// pending rows linked to the same handle — hence limit(1) on the newest row
// rather than maybeSingle(), which throws on multiple matches.
export async function lookupByImessageHandle(
  supabase: SupabaseClient,
  imessageHandle: string
): Promise<PendingUser | null> {
  const { data, error } = await supabase
    .from('pending_users')
    .select('*')
    .eq('imessage_handle', imessageHandle)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`lookupByImessageHandle failed: ${error.message}`);
  return data?.[0] ?? null;
}

export async function markGreeted(supabase: SupabaseClient, code: string): Promise<void> {
  const { error } = await supabase
    .from('pending_users')
    .update({ greeted_at: new Date().toISOString() })
    .eq('code', code);
  if (error) throw new Error(`markGreeted failed: ${error.message}`);
}

// Only purges 'pending' rows. Completed rows must survive so a returning user
// who re-sends their welcome code gets "you're already in" instead of
// "couldn't find that code".
export async function cleanupOld(supabase: SupabaseClient, days: number = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pending_users')
    .delete()
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .select('code');
  if (error) throw new Error(`cleanupOld failed: ${error.message}`);
  return data?.length ?? 0;
}
