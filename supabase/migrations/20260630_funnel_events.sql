-- supabase/migrations/20260630_funnel_events.sql
-- Funnel-stage instrumentation for the concierge loop, so leaks are visible per student:
--   onboarded -> surfaced -> opted_in -> match_proposed -> match_approved -> intro_sent -> showed_up
-- Insert-only append log. Idempotent per (student_id, stage, ref_id) via NULLS NOT DISTINCT (PG15+),
-- so retries and the TWO 'onboarded' completion paths (george update-profile.ts + the bia-roommate
-- web form) cannot double-emit. Call sites insert with ON CONFLICT DO NOTHING. RLS deny-all.

CREATE TABLE IF NOT EXISTS funnel_events (
  id         bigserial PRIMARY KEY,
  student_id uuid NOT NULL,
  stage      text NOT NULL
               CHECK (stage IN ('onboarded','surfaced','opted_in','match_proposed',
                                'match_approved','intro_sent','showed_up')),
  ref_id     uuid,                                    -- post/event/proposal this stage refers to (NULL for 'onboarded')
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_student
  ON funnel_events (student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_events_stage
  ON funnel_events (stage, created_at);

-- Exactly-once per (student, stage, ref). NULLS NOT DISTINCT (PG15+) makes 'onboarded'
-- (ref_id NULL) fire once per student even across the two completion paths / retries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_events_once
  ON funnel_events (student_id, stage, ref_id) NULLS NOT DISTINCT;

ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON funnel_events;
CREATE POLICY "service_role_full_access"
  ON funnel_events FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE funnel_events IS
  'Concierge funnel stage log (onboarded..showed_up). Insert-only, idempotent per (student,stage,ref) via NULLS NOT DISTINCT. Server-only (service-role).';
