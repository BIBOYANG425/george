-- supabase/migrations/20260630_events_source_club.sql
-- Tag events with the partner club/org that supplied them (concierge white-glove cross-org supply).
-- Nullable, additive — does NOT touch the events.source CHECK enum ('bia','usc','instagram','community').
-- The events table has no RLS in 001_george_schema.sql (created plain), so this is a pure column add.
--
-- NOTE: the bia-admin events-editor UI to SET this value is out of this session's scope; data lands
-- in the shared events table and george surfaces it. See the plan's T6.

ALTER TABLE events ADD COLUMN IF NOT EXISTS source_club text;

COMMENT ON COLUMN events.source_club IS
  'Partner club/org that supplied this event (concierge cross-org supply). NULL for BIA-native / scraped events.';
