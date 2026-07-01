-- supabase/migrations/20260630_proposed_matches.sql
-- Concierge match glance (SQUAD lane ONLY). A proposed_matches row is created when
-- CONCIERGE_MATCH_ENABLED=true and the ranker (match_users_for_post) surfaces a candidate for a
-- squad post. An officer approves (admin link OR iMessage /ok) before George fires the intro.
-- The EVENT lane never writes here — event approval happens upstream at event_submissions.
--
-- post_id is a LOGICAL reference to squad_posts (owned by bia-admin, present only in the shared
-- DB). No hard FK on purpose: this george mirror does not define squad_posts, so a FK would break
-- a standalone apply; referential integrity holds against the live shared DB. RLS deny-all
-- (service-role only) — these rows carry recipient identity and must never be anon/authenticated readable.

CREATE TABLE IF NOT EXISTS proposed_matches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid NOT NULL,                        -- candidate/recipient (= squad_pings.recipient_student_id)
  post_id       uuid NOT NULL,                        -- logical ref to squad_posts (shared DB)
  fit_score     double precision NOT NULL,            -- rrf_score from match_users_for_post
  reason        text,                                 -- top matched_tag/best_facet, for the personalized recipient intro
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','sent','expired')),
  officer_id    text,                                 -- officer handle/email that decided (null until decided)
  approve_token text NOT NULL,                        -- per-row nonce for the approve link (NOT the admin token)
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);

-- Officer-notify queue scan (pending, oldest first) + status transitions.
CREATE INDEX IF NOT EXISTS idx_proposed_matches_status_created
  ON proposed_matches (status, created_at);

-- One LIVE proposal per (student, post): re-running proposeMatches must not duplicate a live intro.
-- Must include 'approved' — claimProposal moves the row pending->approved BEFORE delivery, so
-- omitting it would drop the guard during the delivery window (and permanently if a row got stuck
-- 'approved'), allowing a duplicate proposal + double intro. Rejected/expired rows do not block a
-- fresh proposal later (partial predicate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_proposed_matches_live
  ON proposed_matches (student_id, post_id)
  WHERE status IN ('pending','approved','sent');

ALTER TABLE proposed_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON proposed_matches;
CREATE POLICY "service_role_full_access"
  ON proposed_matches FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE proposed_matches IS
  'Squad-lane concierge match glance. Officer approves (admin link or iMessage /ok) before George sends the intro. post_id is a logical ref to squad_posts in the shared DB (no FK). Server-only (service-role).';
