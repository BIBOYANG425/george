-- supabase/migrations/012_user_heartbeat_instructions.sql
-- Per-user standing instructions (HEARTBEAT.md-equivalent).

CREATE TABLE user_heartbeat_instructions (
  user_id uuid PRIMARY KEY REFERENCES students(user_id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_heartbeat_instructions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_can_read_own_instructions"
  ON user_heartbeat_instructions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_can_update_own_instructions"
  ON user_heartbeat_instructions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "service_role_full_access"
  ON user_heartbeat_instructions FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE user_heartbeat_instructions IS 'Per-user HEARTBEAT.md-equivalent. Markdown content read by heartbeat agent each tick.';
