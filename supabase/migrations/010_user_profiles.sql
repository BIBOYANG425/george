-- supabase/migrations/010_user_profiles.sql
-- 6 Letta-style profile blocks per user. Always-loaded into agent context.

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES students(user_id) ON DELETE CASCADE,
  identity text NOT NULL DEFAULT '',
  academic text NOT NULL DEFAULT '',
  interests text NOT NULL DEFAULT '',
  relationships text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  george_notes text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_profiles_updated_at ON user_profiles(updated_at);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_can_read_own_profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_can_update_own_profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "service_role_full_access"
  ON user_profiles FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE user_profiles IS 'Per-user 6-block memory. Always-loaded into agent system prompt.';
