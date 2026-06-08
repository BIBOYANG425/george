-- supabase/migrations/014_student_followups.sql
-- Scheduled commitments george has made to follow up on.

CREATE TABLE student_followups (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  content text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'triggered', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  triggered_at timestamptz
);

CREATE INDEX idx_followups_due
  ON student_followups(scheduled_for, status)
  WHERE status = 'pending';
CREATE INDEX idx_followups_user_status
  ON student_followups(user_id, status);

ALTER TABLE student_followups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_can_read_own_followups"
  ON student_followups FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "service_role_full_access"
  ON student_followups FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE student_followups IS 'Scheduled followups for heartbeat to consume when scheduled_for <= now().';
