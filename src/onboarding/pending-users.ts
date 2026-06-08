// src/onboarding/pending-users.ts
// DB operations for pending_users (migration 015).
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PendingUser {
  code: string;
  imessage_handle: string | null;
  status: 'pending' | 'completed' | 'abandoned';
  created_at: string;
  reminded_at: string | null;
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

export async function markCompleted(supabase: SupabaseClient, code: string): Promise<void> {
  const { error } = await supabase
    .from('pending_users')
    .update({ status: 'completed' })
    .eq('code', code);
  if (error) throw new Error(`markCompleted failed: ${error.message}`);
}

export async function lookupByImessageHandle(
  supabase: SupabaseClient,
  imessageHandle: string
): Promise<PendingUser | null> {
  const { data, error } = await supabase
    .from('pending_users')
    .select('*')
    .eq('imessage_handle', imessageHandle)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw new Error(`lookupByImessageHandle failed: ${error.message}`);
  return data ?? null;
}

export async function cleanupOld(supabase: SupabaseClient, days: number = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pending_users')
    .delete()
    .lt('created_at', cutoff)
    .select('code');
  if (error) throw new Error(`cleanupOld failed: ${error.message}`);
  return data?.length ?? 0;
}
