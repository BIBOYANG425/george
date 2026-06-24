-- supabase/migrations/20260624_user_heartbeat_config_consent_memory.sql
-- Per-user consent for long-term MEMORY writes (the memory→profile feature:
-- per-turn capture + the update_memory tool). Mirrors consent_proactive_messages
-- from 011 exactly: a defensive `false` default so existing rows are no-consent
-- until the student explicitly opts in.
--
-- This is the column george's getMemoryConsent() (src/db/students.ts) reads. It is
-- FAIL-CLOSED: with this column absent it returns false, so capture/update_memory
-- write nothing even with their flags on. Applying this migration is what lets a
-- consented student's facts actually land. The web form / onboarding sets it via
-- the existing user_can_update_own_config RLS policy (auth.uid() = user_id);
-- nothing else here needs to change.

ALTER TABLE user_heartbeat_config
  ADD COLUMN IF NOT EXISTS consent_memory boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN user_heartbeat_config.consent_memory IS
  'Student opt-in for long-term memory writes (per-turn capture + update_memory tool). Defensive false default; gates both writes and profile injection in george, fail-closed.';
