-- supabase/migrations/015_pending_users.sql
-- Onboarding handshake state between iMessage code submission and web profile completion.

CREATE TABLE pending_users (
  code text PRIMARY KEY,
  imessage_handle text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reminded_at timestamptz
);

CREATE INDEX idx_pending_users_handle ON pending_users(imessage_handle) WHERE imessage_handle IS NOT NULL;
CREATE INDEX idx_pending_users_status_created ON pending_users(status, created_at);

ALTER TABLE pending_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access"
  ON pending_users FOR ALL
  USING (auth.role() = 'service_role');

COMMENT ON TABLE pending_users IS 'Transient onboarding state. Auto-purge rows >14 days old via daily cron.';
