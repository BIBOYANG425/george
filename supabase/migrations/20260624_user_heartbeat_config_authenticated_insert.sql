-- supabase/migrations/20260624_user_heartbeat_config_authenticated_insert.sql
-- Authenticated INSERT policy for user_heartbeat_config.
--
-- 011 gave logged-in users SELECT + UPDATE of their own config row (auth.uid() =
-- user_id) but NO INSERT policy — only service_role could insert. The settings hub
-- at /account/george saves consents via a user-scoped PUT that does
-- `.upsert(...)`. An upsert against a row that does NOT yet exist becomes an
-- INSERT, which RLS then rejects — so a student without a pre-existing config row
-- (alpha users, anyone who never completed onboarding, a self-test account) gets a
-- 500 the moment they flip ANY consent toggle (consent_proactive_messages,
-- consent_anomaly_checkin, and now consent_memory all share this path).
--
-- This adds the missing INSERT policy, scoped exactly like the UPDATE one so a user
-- can only create their OWN row. WITH CHECK (not USING) is the INSERT-side guard.
-- Idempotent (DROP IF EXISTS first) so re-running is safe. This is the prerequisite
-- the consent_memory web toggle needs to work for users whose config row is absent.

DROP POLICY IF EXISTS "user_can_insert_own_config" ON user_heartbeat_config;

CREATE POLICY "user_can_insert_own_config"
  ON user_heartbeat_config FOR INSERT
  WITH CHECK (auth.uid() = user_id);
