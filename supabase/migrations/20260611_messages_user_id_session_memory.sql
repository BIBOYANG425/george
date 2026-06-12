-- Conversation memory fix.
--
-- SessionStore (src/agent/session-store.ts) and the heartbeat
-- (src/index.ts loadRecentMessages) read/write the messages table keyed by
-- `user_id` (the channel handle: phone/email). But 001_george_schema.sql only
-- defined `student_id uuid NOT NULL` (FK to students) + `platform NOT NULL`, so
-- every save/load failed — silently, because SessionStore.save console.errors
-- instead of throwing. george therefore had NO conversation memory on any
-- channel.
--
-- Add `user_id text` (indexed) and relax the student-era NOT NULLs so
-- handle-keyed conversation rows persist for any user, including pre-onboarding
-- (no students row yet). student_id stays for onboarded linkage/backfill.
--
-- Applied to prod (project ujkaregrwrppaehvbahf) 2026-06-11 via Supabase MCP.

alter table public.messages add column if not exists user_id text;

create index if not exists messages_user_id_created_idx
  on public.messages (user_id, created_at desc);

alter table public.messages alter column student_id drop not null;
alter table public.messages alter column platform drop not null;
