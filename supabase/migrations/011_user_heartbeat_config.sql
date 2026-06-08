-- supabase/migrations/011_user_heartbeat_config.sql
-- Per-user heartbeat scheduling config + consents.

CREATE TABLE user_heartbeat_config (
  user_id uuid PRIMARY KEY REFERENCES students(user_id) ON DELETE CASCADE,
  cadence interval NOT NULL DEFAULT interval '12 hours',
  active_hours_start time NOT NULL DEFAULT '09:00:00',
  active_hours_end time NOT NULL DEFAULT '22:00:00',
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  paused boolean NOT NULL DEFAULT false,
  pause_until timestamptz,
  last_heartbeat_at timestamptz,
  consent_proactive_messages boolean NOT NULL DEFAULT false,
  consent_anomaly_checkin boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_heartbeat_config_due
  ON user_heartbeat_config(last_heartbeat_at, paused)
  WHERE paused = false;

ALTER TABLE user_heartbeat_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_can_read_own_config"
  ON user_heartbeat_config FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_can_update_own_config"
  ON user_heartbeat_config FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "service_role_full_access"
  ON user_heartbeat_config FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE user_heartbeat_config IS 'Per-user heartbeat scheduling + consents. Default: cadence=12h, defensive false on consents.';
