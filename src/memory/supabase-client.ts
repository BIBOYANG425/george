// src/memory/supabase-client.ts
// Service-role Supabase client for the memory layer.
// Uses env vars directly (not config) so this module can load
// without triggering the full config validation at import time.
import { createClient } from '@supabase/supabase-js';

export function createServiceRoleClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
