-- supabase/migrations/20260625_message_flags.sql
-- Admin "bad turn" flags for AI-quality review (dashboard PR-2). A flag records a
-- human judgment that a specific George reply was bad (off-voice, wrong, fabricated)
-- so the team can review patterns over time.
--
-- The flag carries a SNAPSHOT of the turn's run context (content / model / agent /
-- tool_calls) at flag time, NOT just a foreign key. Two reasons:
--   1. The review must survive the message being edited or deleted — the snapshot is
--      the durable record, so message_id is `on delete set null` (the flag lives on).
--   2. tool_calls/model on the live row can be backfilled or change; the snapshot
--      freezes "what produced this turn" as the reviewer saw it.
--
-- Read fail-soft by the dashboard (getFlaggedTurns): with this table absent the
-- Review page degrades to a "未迁移" panel rather than 500-ing. merge != live —
-- this migration must be applied to prod before flags persist.

create table if not exists message_flags (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references messages(id) on delete set null,
  user_id text,                       -- channel handle the turn belongs to (denormalized for fast review filtering)
  kind text not null,                 -- 'bad_turn' | 'fabrication' | 'off_voice' | ... (admin-curated, not constrained)
  reason text,                        -- optional human note ("invented a price", "wrong prof")
  model text,                         -- snapshot: model that produced the turn (from tool_calls telemetry)
  agent text,                         -- snapshot: routed sub-agent
  tool_calls jsonb,                   -- snapshot: the turn's tool_calls telemetry blob
  context_snapshot jsonb default '{}'::jsonb,  -- snapshot: { content, createdAt } so review survives row deletion
  actor text not null,                -- admin who flagged (cf-access email, or 'admin-token' locally)
  created_at timestamptz default now()
);

create index if not exists idx_message_flags_created on message_flags(created_at desc);
create index if not exists idx_message_flags_message on message_flags(message_id);
create index if not exists idx_message_flags_kind on message_flags(kind);

-- Lock the table to the service role ONLY. message_flags carries snapshot message
-- CONTENT (PII) + reviewer notes, so it must never be readable through the anon /
-- authenticated PostgREST roles the web app uses. Enabling RLS with NO policies
-- denies anon/authenticated entirely; the service-role key (which george's backend
-- + dashboard use) bypasses RLS, so the dashboard keeps full access. Same posture
-- as the Slice β tables (010-015). Defense-in-depth behind the dashboard auth gate.
alter table message_flags enable row level security;

comment on table message_flags is
  'Admin AI-quality flags on George turns (dashboard PR-2). Carries a run-context snapshot so the review survives message deletion; message_id is on delete set null.';
