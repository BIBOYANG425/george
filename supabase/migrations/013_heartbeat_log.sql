-- supabase/migrations/013_heartbeat_log.sql
-- Append-only audit trail for every heartbeat tick.

CREATE TABLE heartbeat_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'block_update', 'proactive_send', 'followup_scheduled', 'error')),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text
);

CREATE INDEX idx_heartbeat_log_user_fired ON heartbeat_log(user_id, fired_at DESC);
CREATE INDEX idx_heartbeat_log_fired ON heartbeat_log(fired_at DESC);

ALTER TABLE heartbeat_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_can_read_own_logs"
  ON heartbeat_log FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "service_role_full_access"
  ON heartbeat_log FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE heartbeat_log IS 'Append-only heartbeat audit. Truncate rows >90 days via monthly cron.';
