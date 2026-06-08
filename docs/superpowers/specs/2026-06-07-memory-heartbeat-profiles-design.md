# george Memory + Heartbeat Design

**Date:** 2026-06-07
**Status:** DRAFT (pending user review)
**Brainstormed via:** `/superpowers:brainstorming` 2026-06-07
**Builds on:** `2026-06-07-orchestrator-3-intent-agents-design.md` (this layers on top)

## Goal

Give george per-user long-term memory plus a background process that drives memory consolidation and proactive interactions. The pattern combines Letta-style core memory blocks (for what george knows about each user) with OpenClaw-style scheduled heartbeats (for when and how george thinks about each user without being prompted). Subsume the Event Brief cron from the orchestrator spec — Event Brief becomes one outcome of the heartbeat, not a separate scheduler.

The objective is memory-driven thoughtfulness as a moat. ChatGPT and Series cannot send "you got this" on the morning of a USC freshman's BUAD 280 presentation because they have no persistent per-user state that tracks commitments. george can. That's the differentiator.

## Relationship to other specs

- `2026-06-07-orchestrator-3-intent-agents-design.md` (Slice α) ships first. This spec layers memory and heartbeat ON TOP of the orchestrator + 3 sub-agents.
- The 6 profile blocks are loaded into every agent's system prompt (orchestrator + 3 sub-agents) at session start, alongside the master prompt and specialization prompt.
- The `sessionStore` adapter from the orchestrator spec is extended to load profile blocks alongside conversation state.
- The Event Brief cron from the orchestrator spec is REMOVED; replaced by heartbeat-driven brief generation.

This work becomes Slice β; lands AFTER Slice α (orchestrator + Claude Agent SDK migration) and BEFORE Slice 0.5 (migrations reconcile). The order matters: Slice α gives us the SDK foundation, Slice β adds memory + heartbeat on top, then Slice 0.5 reconciles all the new tables alongside existing ones.

## Architecture

```
                    HEARTBEAT SCHEDULER (node-cron, fires every 10 min)
                                          │
                          ┌───────────────┼─────────────────┐
                          │ For each user with due heartbeat:                │
                          │   - cadence elapsed since last_heartbeat_at?     │
                          │   - within active_hours?                         │
                          │   - not paused?                                  │
                          │ If yes → dispatch (Promise.allSettled, 60s each) │
                          └───────────────┼─────────────────┘
                                          ▼
              ┌───────────────────────────────────────────────────────────┐
              │  PER-USER HEARTBEAT (isolated query() call, Haiku model)   │
              │  ────────────────────────────────────────────────────────  │
              │                                                           │
              │  Load:                                                    │
              │   • user_profiles.{6 blocks}            ← via KV cache     │
              │   • user_heartbeat_instructions.content ← via KV cache     │
              │   • recent 10 messages from this user   ← Postgres direct  │
              │   • current calendar mood overlay                          │
              │                                                           │
              │  System prompt =                                          │
              │   master_prompt                                           │
              │   + heartbeat_prompt                                      │
              │   + standing_instructions (per-user)                       │
              │   + "USER PROFILE:\n[6 blocks rendered]\n"                 │
              │   + "RECENT CONTEXT:\n[last 10 messages]\n"                │
              │                                                           │
              │  Tools available:                                         │
              │   • update_block(name, content, reason)                    │
              │   • send_proactive_message(text, channel)                  │
              │   • add_followup(text, scheduled_for)                      │
              │   • heartbeat_ok()  ← explicit no-op (preferred return)    │
              │                                                           │
              │  One outcome per heartbeat:                                │
              │   • HEARTBEAT_OK (nothing to do)                           │
              │   • Block updated (memory consolidation)                   │
              │   • Proactive message sent (event brief / check-in /       │
              │      followup / anomaly response)                         │
              │   • Future followup scheduled                              │
              │                                                           │
              │  Always logged to heartbeat_log audit table.              │
              └───────────────────────────────────────────────────────────┘
                                          │
                                          │ writes invalidate cache
                                          ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  STORAGE                                                       │
        │  ───────                                                       │
        │  Postgres (source of truth):                                  │
        │   • user_profiles          (6 MD-formatted TEXT columns)      │
        │   • user_heartbeat_config  (cadence, active_hours, paused)    │
        │   • user_heartbeat_instructions (TEXT, per-user standing doc) │
        │   • heartbeat_log          (audit trail, append-only)         │
        │   • student_followups      (scheduled actions, append-only)   │
        │                                                                │
        │  Cloudflare KV (edge cache):                                  │
        │   • Key: user:{userId}:profile      TTL 5min                  │
        │   • Key: user:{userId}:instructions TTL 5min                  │
        │   • Invalidated on heartbeat block update                     │
        │                                                                │
        │  Read latency:                                                │
        │   • Cache hit (Cloudflare KV at edge): 10-30ms                │
        │   • Cache miss (Postgres single query): 50-100ms              │
        │   • Profile loaded on EVERY reactive turn + every heartbeat   │
        └───────────────────────────────────────────────────────────────┘
```

## Components

### Files to CREATE

In `~/Code/george/`:

- `src/agent/heartbeat.ts` — the per-user heartbeat handler. Loads profile + instructions + recent messages, builds prompt, calls `query()` with the 4 heartbeat tools, processes the outcome, logs to `heartbeat_log`.
- `src/agent/memory.ts` — profile read/write API + KV cache layer. Functions: `loadProfile(userId)`, `saveBlock(userId, blockName, content)`, `invalidateCache(userId)`, `loadHeartbeatInstructions(userId)`, `saveHeartbeatInstructions(userId, content)`.
- `src/jobs/heartbeat-scheduler.ts` — node-cron job that fires every 10 minutes. Queries `user_heartbeat_config` for due users, dispatches `runHeartbeat(userId)` per user via `Promise.allSettled` with 60s timeout each.
- `src/tools/heartbeat/update-block.ts` — heartbeat-only tool. Zod schema validates block name (must be one of 6) and content (max 2000 chars). Writes to Postgres + invalidates KV.
- `src/tools/heartbeat/send-proactive-message.ts` — heartbeat-only tool. Writes to `imessage_outgoing` (existing table) or web push queue. Enforces rate limit: at most 1 proactive per user per heartbeat.
- `src/tools/heartbeat/add-followup.ts` — heartbeat-only tool. Writes to `student_followups` table with `scheduled_for` timestamp. Heartbeats check this table on each fire and can trigger followup actions when their time arrives.
- `src/tools/heartbeat/heartbeat-ok.ts` — explicit no-op tool. Returns `{ content: [{ type: 'text', text: 'HEARTBEAT_OK' }] }` to satisfy the SDK's expectation of a tool call. Heartbeat handler treats this as the canonical "nothing to do" outcome.
- `prompts/heartbeat.md` — heartbeat-specific specialization prompt. Defines the heartbeat agent's reasoning rules: when to update blocks, when to send proactive, when to do nothing (the most common outcome), how to detect anomalies (user silent for N days), Event Brief generation rules.
- `src/tools/user-commands.ts` — handles user-issued control commands: `/profile`, `/correct`, `/pause`, `/resume`, `/delete me`. Each command is a tool the orchestrator can invoke when a user types one of these phrases.
- `supabase/migrations/010_user_profiles.sql` — `user_profiles` table with 6 MD-formatted TEXT columns + updated_at + user_id PK.
- `supabase/migrations/011_user_heartbeat_config.sql` — `user_heartbeat_config` table: user_id PK, cadence interval, active_hours_start time, active_hours_end time, timezone text, paused boolean, pause_until timestamptz, last_heartbeat_at timestamptz.
- `supabase/migrations/012_user_heartbeat_instructions.sql` — `user_heartbeat_instructions` table: user_id PK, content text, updated_at.
- `supabase/migrations/013_heartbeat_log.sql` — `heartbeat_log` table: id, user_id, fired_at, duration_ms, outcome text (one of 'ok', 'block_update', 'proactive_send', 'followup_scheduled', 'error'), actions jsonb, error_message text.
- `supabase/migrations/014_student_followups.sql` — `student_followups` table: id, user_id, content text, scheduled_for timestamptz, status text (pending/triggered/cancelled), created_at, triggered_at.
- `supabase/migrations/015_pending_users.sql` — `pending_users` table: code text PK, imessage_handle text, status text default 'pending', created_at timestamptz default now(), reminded_at timestamptz. Used for onboarding handshake state between iMessage code submission and web profile completion.
- `tests/agent/heartbeat.test.ts` — heartbeat agent loop tests. Covers: HEARTBEAT_OK for quiet user, block update for active user, proactive event brief on Wednesday for opted-in user, followup trigger on its scheduled date, anomaly detection (user silent 14 days) sends gentle check-in if user opted in.
- `tests/agent/memory.test.ts` — memory layer tests. Covers: profile load (cache hit + cache miss paths), block save invalidates cache, all 6 blocks round-trip correctly, MD content preserved including code blocks and Chinese characters.
- `tests/jobs/heartbeat-scheduler.test.ts` — scheduler logic. Covers: due-user query correctness, active-hours boundary cases (00:00, 22:00, midnight wrap), paused user skipped, pause_until expiration auto-resumes, parallel dispatch via Promise.allSettled, 60s timeout enforced.
- `tests/tools/user-commands.test.ts` — control command tests. Covers: /profile renders all 6 blocks, /correct updates specific block, /pause sets pause_until, /resume clears it, /delete me 2-step confirmation, /delete me clears all 5 tables for that user.

In `~/Code/bia-roommate/` (web UI for heartbeat config):

- `bia-roommate/app/account/heartbeat/page.tsx` — heartbeat preferences page: cadence (every 4h / 12h / 24h / off), active hours (start/end time pickers), pause toggle, "what george remembers about me" panel showing all 6 blocks read-only.
- `bia-roommate/app/account/heartbeat/api/route.ts` — POST handler writes to `user_heartbeat_config`. Invalidates KV cache for that user.
- `bia-roommate/app/account/profile/page.tsx` — editable view of the 6 profile blocks (markdown editor per block). Writes via /correct flow.

### Files to MODIFY

- `src/agent/orchestrator.ts` (from Slice α) — extend the `sessionStore.load(userId)` flow to also load the 6 profile blocks from `memory.loadProfile(userId)` and inject them into the system prompt as a "USER PROFILE:\n[blocks]\n" section. This makes profile context available to the orchestrator AND every sub-agent it calls.
- `src/agent/agents.config.ts` (from Slice α) — each sub-agent's `prompt` field gets the user profile injection at runtime (same as orchestrator). The 6 blocks are part of every system prompt.
- `prompts/master.md` (from Slice α) — add a section: "You will receive USER PROFILE context. Treat it as ground truth about this user. Use it to be specific and personal in responses."
- `src/index.ts` — handle the 5 user-command phrases (`/profile`, `/correct ...`, `/pause [duration]`, `/resume`, `/delete me`) by routing to `user-commands.ts` before invoking the orchestrator.
- `src/jobs/` — REMOVE the standalone Event Brief cron from the orchestrator spec; its functionality moves into the heartbeat handler (Event Brief is one outcome among many that the heartbeat agent can choose).
- `CLAUDE.md`, `README.md`, `AGENT.md` — describe the memory + heartbeat architecture. Include the user-facing control commands. Note that profile blocks are part of every system prompt.

### Files to DELETE

- `src/jobs/event-brief-cron.ts` (if it was built during Slice α before Slice β supersedes it). Heartbeat absorbs this responsibility.
- `src/tools/event-brief-generator.ts` keeps existing logic but moves under `src/tools/heartbeat/` since it's only called from inside the heartbeat agent.

## Profile schema (6 blocks)

Each block is markdown-formatted TEXT (max 2000 chars per block), stored as a column in `user_profiles`. Blocks are always-loaded into every agent's system prompt at session start. Total budget: ~3-12 KB of context per user (depending on how full blocks are).

| Block | Purpose | Example content |
|---|---|---|
| `identity` | Stable facts that rarely change | `name: Sarah Chen`, `year: junior (entered fall 2024)`, `major: undeclared, leaning IYA`, `hometown: Shanghai`, `native_language: Mandarin`, `english_level: fluent`, `pronouns: she/her` |
| `academic` | Current academic state | `current_courses: CSCI 270 (Sweeney, exam 12/8), BUAD 280, ECON 203`, `gpa_concern: trying to keep 3.5+`, `study_style: collaborative > solo` |
| `interests` | Hobbies, activities, preferences | `hobbies: hiking (Saturday crew), food (looking for hot pot spots), photography`, `code_switch_pref: mixes Mandarin/English naturally`, `tone_pref: lowercase + casual` |
| `relationships` | Known people in this user's network | `cohort_senior: Wei (assigned)`, `squad: Alex (hiking), Mike (study group CSCI 270)`, `recent_intros_made: introduced to Lin 5/22 for hiking, hit it off` |
| `state` | Slow-moving emotional/contextual state | `current_stress: moderate (midterm prep)`, `recent_topic_foci: IYA major decision, hiking squad expansion`, `last_active: 2026-06-07`, `silence_pattern: typical 2-3 day gaps` |
| `george_notes` | Things george has committed to remember | `presentation_BUAD280: nervous re: Dec 11 presentation, check-in Dec 9 evening`, `IYA_decision_followup: said would decide major by end of summer`, `event_RSVP_pending: maybe attend AEPi hotpot 6/13` |

**Block names are fixed; content is freeform markdown.** The 6-block structure stays stable across all users; what changes between users is the content. Heartbeat agent can only call `update_block` with one of these 6 names.

### Block update rules (heartbeat agent enforces)

- Updates should be COMPLETE rewrites of the block, not append-only. The heartbeat reads the current block + recent context, decides what the block SHOULD say now, writes that.
- An update must compress meaningfully — if the new content is the same as the old or longer without new info, skip the update (return HEARTBEAT_OK or update a different block).
- `george_notes` is the only block that explicitly grows over time (commitments accumulate). On update, the heartbeat agent should prune fulfilled or stale commitments.
- `state` updates daily-ish; `interests` and `relationships` weekly-ish; `identity` and `academic` rarely (course list at start of term).

## Heartbeat config schema

`user_heartbeat_config` row per user:

| Field | Type | Default | Meaning |
|---|---|---|---|
| user_id | text PK | - | Foreign key to `students.user_id` |
| cadence | interval | `'4 hours'` | How often to fire heartbeat |
| active_hours_start | time | `'09:00'` | Earliest local time to fire |
| active_hours_end | time | `'22:00'` | Latest local time to fire |
| timezone | text | `'America/Los_Angeles'` | User's timezone |
| paused | boolean | `false` | If true, scheduler skips this user |
| pause_until | timestamptz | NULL | If set and future, auto-resume after |
| last_heartbeat_at | timestamptz | NULL | When last heartbeat fired |
| consent_proactive_messages | boolean | `false` | Must be true for `send_proactive_message` tool to actually send |
| consent_anomaly_checkin | boolean | `false` | If true, heartbeat can ping after N days of silence |

**Defaults:**

- *Column-level defaults* (defensive, apply if a row appears without explicit values): cadence='4 hours', paused=false, consent_proactive_messages=false, consent_anomaly_checkin=false. Defensive defaults protect against accidental enabling if someone bypasses onboarding.
- *Onboarding-form defaults* (what new users typically end up with): cadence per form choice, consent_proactive_messages=true (opt-out checkbox, ON by default), consent_anomaly_checkin=false (opt-in checkbox, OFF by default). The onboarding form writes explicit values, so column defaults only kick in for non-form-driven inserts.

## Onboarding contract

Onboarding is implemented in Slice B (separate plan) but the memory + heartbeat layer defines the contract Slice B must satisfy. The flow inverts the traditional "long form first, agent later" pattern: the relationship starts in iMessage, the web is a doorway plus a 2-minute profile form. This protects the first impression (george greets you before you fill anything out) and uses the iMessage handshake as a consent gesture (no profile written until you actually want this).

### Flow

```
1. Web: uscbia.com/george
   • Single landing page, no form
   • Headline + brief value prop + one button: "Connect with george"
   • Button opens iMessage with pre-populated body:
       sms:+1XXX&body=g7k2m4-START
     (the 6-char code is generated server-side per page-load and
      embedded in the sms: link; user just taps Send)

2. iMessage handshake (5 messages in sequence)
   • george's iMessage handler receives "g7k2m4-START"
   • Creates pending user row: { code, imessage_handle, status:'pending' }
   • Responds with:
       (a) Greeting text — warm, lowercase, sets tone
       (b) george's contact card attachment (george.vcf)
       (c) "what I can do" intro line
       (d) 5 visual showcase images, sent as iMessage attachments:
           - Squad: george matches 3 students for a hike
           - Event brief: sample weekly brief in BIA brand style
           - Find people: connecting two students with shared interests
           - USC knowledge: george answering Q about IYA
           - Companion: george listening to exam stress
           Each image has a one-line caption.
       (e) Onboarding link: "ready to set up? takes 2 min:
            uscbia.com/george/profile?code=g7k2m4"

3. Web: uscbia.com/george/profile?code=g7k2m4
   • Resolves code → links iMessage handle that's already in pending row
   • Step 1: USC email verification (Supabase auth magic link, 6-digit
     fallback)
   • Step 2: Identity (name, year, major, hometown, native language,
     pronouns)
   • Step 3: Interests (multi-select chips + free text)
   • Step 4: How george reaches you
     - cadence (daily 8am / weekly Wed 8am / off)
     - active hours (default 09:00-22:00 LA)
     - consent_proactive_messages (default ON)
     - consent_anomaly_checkin (default OFF)
   • On submit:
     - Write user_profiles, user_heartbeat_config,
       user_heartbeat_instructions (the 3-table contract below)
     - Pair cohort_senior (load-balanced from cohort_seniors table)
     - Notify senior via Slack/Discord webhook
     - Confirmation: "george knows you now. open iMessage to keep
       talking."

4. Heartbeat picks up within 10 min after profile submit
   • First heartbeat: observational only
   • Standing instructions for first 24h: "user just completed profile,
     be welcoming, no proactive nudges yet"
   • After 24h: heartbeats may send proactive per consent + cadence
```

### Three-table write contract (Slice B implements this exact shape)

On profile-submit (web step 3):

```sql
INSERT INTO user_profiles (user_id, identity, academic, interests,
                            relationships, state, george_notes)
VALUES (
  $userId,
  '<MD from form: name/year/major/hometown/native_language/pronouns>',
  'year: $year, major: $major',
  '<MD from form: categories + free text>',
  'cohort_senior: $assignedSenior (assigned $today)',
  'new_user: true, onboarded_at: $now',
  ''
);

INSERT INTO user_heartbeat_config (user_id, cadence, active_hours_start,
                                    active_hours_end, timezone,
                                    consent_proactive_messages,
                                    consent_anomaly_checkin,
                                    last_heartbeat_at)
VALUES (
  $userId,
  '4 hours',
  '09:00', '22:00',
  $detectedTimezone,
  $consentProactive,
  $consentAnomaly,
  NULL  -- eligible for next scheduler tick
);

INSERT INTO user_heartbeat_instructions (user_id, content)
VALUES (
  $userId,
  '<MD body: "user just onboarded YYYY-MM-DD. cadence: $X. interests:
   $Y. consent flags: $Z. first 24h: be welcoming + observational, no
   proactive messages. after 24h: per consent + cadence.">'
);
```

### Pending user state (between iMessage handshake and profile completion)

Between step 2 and step 3, the user has an iMessage relationship with george but no profile. The pending user row tracks this:

```sql
CREATE TABLE pending_users (
  code text PRIMARY KEY,                     -- 6-char code
  imessage_handle text,                      -- linked after handshake
  status text DEFAULT 'pending',             -- pending | completed | abandoned
  created_at timestamptz DEFAULT now(),
  reminded_at timestamptz                    -- last reminder sent
);
```

What george does for pending users who keep messaging without completing profile:

- First 2 messages: respond normally with generic-USC-helper persona (no personalization)
- 3rd message onward: gentle soft-nudge in response: "btw, takes 2 min to set up so I can actually help you: [link]"
- Day 7: 1 reminder email if email captured at landing
- Day 14: clean up the pending row + drop iMessage handle linkage

What happens if a pending user just abandons:

- iMessage handle stays linked but george has no profile context
- Heartbeats DO NOT fire for pending users (scheduler query requires `user_profiles` row exists)
- No proactive messages risk going to abandoned users
- After 14 days: pending row purged, iMessage handle delinked, user starts fresh if they re-enter

### Edge cases

| Case | Handling |
|---|---|
| User clicks "Connect" but never sends the iMessage | Page-side: code expires after 30 min, fresh code on page reload |
| User sends iMessage handshake but never opens profile link | Pending state; gentle nudge at message 3, reminder day 7, purge day 14 |
| User completes web profile but then deletes george's contact | Heartbeat detects iMessage failures, marks `consent_proactive_messages=false` after 3 consecutive failures, no further attempts |
| User onboards twice (same email, different phone) | Second attempt: if first completed, error "already onboarded"; if first pending, overwrite |
| Non-USC email at step 1 | Reject with: "george is currently for USC students. if you're admitted and don't have @usc.edu yet, [contact form link]." |
| User wants to delete and re-onboard | `/delete me` clears everything; user can restart from uscbia.com/george |

### Visual showcase assets (Slice B owns the creation)

5 images, all in BIA brand style (cream `#F2EBD9`, deep cardinal `#71031F`, teal `#4FAFA6`, Instrument Serif italic, hand-illustrated cherry blossoms). Each image is sent as a separate iMessage attachment during handshake step 2(d), with a one-line caption.

| # | Topic | Caption |
|---|---|---|
| 1 | Squad mode | "tap me to find your hike crew, study group, or hotpot squad" |
| 2 | Event brief | "weekly briefs of bia + usc events, in your inbox" |
| 3 | Find people | "tell me what you're looking for, I find the right people" |
| 4 | USC knowledge | "ask me anything usc — academics, dps zones, iya, the works" |
| 5 | Companion | "I remember what you tell me. always here." |

These get designed during Slice B and stored as static assets in the george repo (`assets/onboarding/showcase-{1..5}.png`).

### Implementation notes for Slice B

- The `pending_users` table is new; add as migration 015 alongside the other memory + heartbeat migrations.
- The Connect button uses `sms:` URL scheme on iOS/Mac. On Android (rare for USC students but possible), fall back to displaying the code + george's number for manual typing.
- The contact card (`george.vcf`) is static; built once, served from `bia-roommate/public/george.vcf`.
- All onboarding state changes write to `admin_audit_log` (pending creation, handshake, profile submit, abandonment, deletion).
- Cohort senior pairing logic lives in `bia-admin` (it owns the `cohort_seniors` table); the profile submit handler calls a bia-admin internal API.

## Standing instructions (per-user HEARTBEAT.md equivalent)

`user_heartbeat_instructions` table, one row per user, single TEXT column. Markdown content with sections like:

```markdown
# Standing instructions for Sarah Chen

## Event brief preference
- Cadence: weekly_wed
- Categories: food, hiking, study groups, career talks
- Last brief sent: 2026-06-04 (8 days ago — DUE today)

## Followups
- presentation_BUAD280: send "you got this" Dec 9 evening
- IYA_decision_check: ping early August re: major decision

## Tone calibration
- Sarah prefers concise (no more than 2 sentences for nudges)
- Mixes Mandarin and English; reply in matching language

## What to skip
- No academic advice unsolicited (she's working with an advisor)
- Don't ping during 22:00-09:00 LA (default but explicit)
```

This file is auto-generated on user onboarding from their preferences, then updated by the heartbeat agent itself over time as it learns the user (e.g., heartbeat noticed user always responds positively to food events → updates the categories list).

The heartbeat agent reads this file at the start of every tick. It serves as the "what should I be paying attention to for this user" instruction layer, distinct from the always-loaded profile blocks.

## Data flow

### Reactive turn (user-initiated message)

```
1. User DMs george via iMessage.
2. /imessage/incoming handler receives, looks up userId from phone number.
3. Check for user-command prefix (/profile, /correct, /pause, /resume, /delete me) → if match, route to user-commands.ts and return.
4. Otherwise: runOrchestrator(userId, 'imessage', text).
5. memory.loadProfile(userId) → KV cache hit (~20ms) or Postgres read (~80ms).
6. sessionStore.load(userId) → loads recent N messages from `messages` table.
7. Orchestrator system prompt assembled = master + orchestrator_prompt + "USER PROFILE:\n[6 blocks]\n" + "[conversation history]"
8. Agent SDK query() runs.
9. Response streams back to user via iMessage.
10. Conversation turn written to `messages` (existing flow).
11. NO profile updates happen here — that's the heartbeat's job.
```

### Heartbeat tick (per-user, every 4h active hours)

```
1. node-cron fires at minute 0, 10, 20, 30, 40, 50 of every hour.
2. heartbeat-scheduler.ts queries: SELECT user_id FROM user_heartbeat_config WHERE
   paused = false
   AND (pause_until IS NULL OR pause_until < now())
   AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - cadence)
   AND CURRENT_TIME(timezone) BETWEEN active_hours_start AND active_hours_end;
3. For each due user (typically 50-200 users per tick at scale), Promise.allSettled with 60s per-user timeout:
   a. memory.loadProfile(userId) → KV or Postgres
   b. memory.loadHeartbeatInstructions(userId) → KV or Postgres
   c. Load last 10 messages from this user
   d. Query student_followups for any scheduled_for <= now() AND status='pending'
   e. Build heartbeat prompt: master + heartbeat_prompt + standing_instructions + USER PROFILE + RECENT CONTEXT + PENDING FOLLOWUPS
   f. query() with allowed tools: update_block, send_proactive_message, add_followup, heartbeat_ok
   g. Agent reasons + calls one tool
   h. Outcome logged to heartbeat_log
   i. user_heartbeat_config.last_heartbeat_at updated
4. Aggregate metrics (total fired, % HEARTBEAT_OK, average duration_ms) logged to observability.
```

### Event Brief delivery (special case of heartbeat)

```
1. Wednesday 09:00-13:00 LA: heartbeat ticks for users with cadence='4 hours' will eventually pick up Sarah whose user_heartbeat_config and standing instructions imply weekly Wed brief.
2. Heartbeat agent reads standing instructions, notices "Cadence: weekly_wed, Last brief sent: 8 days ago — DUE today".
3. Agent calls event_brief_generator (now under src/tools/heartbeat/) with userId + 7-day window + interest tags from `interests` block.
4. Tool returns 3-5 ranked events.
5. Agent calls send_proactive_message with the brief text.
6. Heartbeat log records outcome='proactive_send', actions=[{tool: 'event_brief_generator', tool: 'send_proactive_message'}].
7. Standing instructions get updated by the heartbeat: "Last brief sent: 2026-06-07".
8. Next Wednesday's heartbeat sees fresh last_sent timestamp, doesn't double-send.
```

### Followup trigger (commitment-driven)

```
1. 3 weeks ago heartbeat read a conversation where Sarah mentioned BUAD 280 presentation Dec 11.
2. Heartbeat called add_followup("Sarah's BUAD 280 presentation tomorrow, send encouragement", "2026-12-10T21:00:00-08:00").
3. Inserted row in student_followups, scheduled_for=Dec 10 9 PM LA.
4. Heartbeat scheduler runs Dec 10 ~21:00 LA, picks Sarah (cadence + active hours both met).
5. Heartbeat handler loads pending followups, sees the one due now.
6. Agent reasons: "this followup is for tomorrow's presentation; send encouragement now."
7. Agent calls send_proactive_message with personalized "you got this. break a leg" message.
8. Marks followup row status='triggered', triggered_at=now().
9. Heartbeat log: outcome='proactive_send'.
```

### Anomaly detection (silence → optional check-in)

```
1. Sarah hasn't messaged in 14 days. consent_anomaly_checkin = true.
2. Heartbeat fires (still happens every 4h regardless of silence).
3. Agent reads recent messages (10 most recent, all from 14+ days ago).
4. State block reads "silence_pattern: typical 2-3 day gaps" — this 14-day gap is anomalous.
5. Agent reasons: "anomaly, but user opted in to check-in. Send a single low-key DM."
6. Calls send_proactive_message: "hey, been a bit. anything come up? no pressure to reply."
7. Marks state block: "last_anomaly_checkin: 2026-06-07; cooldown 14 days before next."
8. If consent_anomaly_checkin had been false, agent would have returned HEARTBEAT_OK instead.
```

## Tools available during heartbeat

Each is a Zod-typed tool registered ONLY to the heartbeat agent (not orchestrator, not sub-agents).

### `update_block(name, content, reason)`

```typescript
tool('update_block', 'Update one profile block. Heartbeat-only.',
  {
    block_name: z.enum(['identity', 'academic', 'interests', 'relationships', 'state', 'george_notes']),
    new_content: z.string().max(2000),
    reason: z.string().describe('1-2 sentence why this update is meaningful'),
  },
  async ({ block_name, new_content, reason }) => {
    // Validate: new_content differs from current in a meaningful way.
    // If trivial diff (same after whitespace normalization), return error.
    // Save to Postgres, invalidate KV.
    // Append to heartbeat_log.actions with the diff + reason.
    return { content: [{ type: 'text', text: `Updated ${block_name}: ${reason}` }] };
  }
);
```

### `send_proactive_message(text, channel)`

```typescript
tool('send_proactive_message', 'Send an unprompted message to the user. Heartbeat-only.',
  {
    text: z.string().min(10).max(500),
    channel: z.enum(['imessage', 'web']).default('imessage'),
  },
  async ({ text, channel }) => {
    // Check user_heartbeat_config.consent_proactive_messages.
    // If false, return error.
    // Enforce: only 1 proactive per heartbeat tick (track in scratch state).
    // Write to imessage_outgoing or web push queue.
    // Append to heartbeat_log.actions.
    return { content: [{ type: 'text', text: `Sent: "${text.slice(0, 80)}..."` }] };
  }
);
```

### `add_followup(text, scheduled_for)`

```typescript
tool('add_followup', 'Schedule a future commitment for george to remember.',
  {
    text: z.string().max(300),
    scheduled_for: z.string().datetime().describe('ISO 8601 timestamp'),
  },
  async ({ text, scheduled_for }) => {
    // Insert into student_followups.
    // Status = 'pending'.
    return { content: [{ type: 'text', text: `Followup scheduled for ${scheduled_for}` }] };
  }
);
```

### `heartbeat_ok()`

```typescript
tool('heartbeat_ok', 'No action needed this tick. Preferred return when nothing meaningful happened.',
  {},
  async () => {
    return { content: [{ type: 'text', text: 'HEARTBEAT_OK' }] };
  }
);
```

## Storage and caching detail

### Postgres (source of truth)

6 new tables (migrations 010-015). All have RLS enabled with policy "users access only their own row, service-role bypass for cron." Row counts at 1K users:
- `user_profiles`: 1K rows, ~12 KB per row (6 blocks × 2KB max), total ~12 MB
- `user_heartbeat_config`: 1K rows, small
- `user_heartbeat_instructions`: 1K rows, ~2 KB per, total ~2 MB
- `heartbeat_log`: append-only, ~3 ticks/user/day × 1K users × 365 days = ~1.1M rows/year. Add monthly partition or truncate >90 days.
- `student_followups`: ~50 active followups per user, ~50K rows total.
- `pending_users`: transient state during onboarding handshake; ~100-500 rows live at any time, auto-purged at day 14.

### Cloudflare KV (edge cache)

- Keys: `user:{userId}:profile`, `user:{userId}:instructions`
- TTL: 300 seconds (5 minutes)
- Invalidation: writes from `update_block` / `saveHeartbeatInstructions` call `cache.delete(key)` before returning.
- Cache miss rate target: <20% (most reactive turns hit cache because heartbeat runs every 4h, leaving long warm-cache periods).

### Latency table

| Operation | Path | p50 | p95 |
|---|---|---|---|
| Profile load (cache hit) | KV read | 10-15ms | 30ms |
| Profile load (cache miss) | Postgres + cache populate | 60-80ms | 150ms |
| Block save | Postgres + KV invalidate | 40-60ms | 100ms |
| Heartbeat full tick | Load + LLM + write | 5-10s | 30s |
| Reactive turn (end-to-end) | Load + LLM + write | 2-3s | 5s |

## User-facing control commands

| Command | Behavior |
|---|---|
| `/profile` | Returns the 6 blocks rendered in plain English ("here's what I know: ..."). Routed by orchestrator to user-commands.ts; no sub-agent needed. |
| `/correct <block_name> <new content>` | Updates one block directly (bypasses heartbeat). Requires user confirmation via prompt-and-confirm flow. Audit-logged. |
| `/pause [duration]` | Sets `paused=true` and optionally `pause_until=now()+duration` (defaults to 7 days). Heartbeats skipped during pause. |
| `/resume` | Clears pause state. Next scheduled heartbeat fires normally. |
| `/delete me` | 2-step confirmation. On confirm: clears all 5 user tables (user_profiles, user_heartbeat_config, user_heartbeat_instructions, heartbeat_log, student_followups) + clears `messages` + `student_memories` (from existing schema) for that user. Sends final "goodbye" message. Removes iMessage contact (sets a flag the iMessage adapter checks). |

All commands log to `admin_audit_log` for traceability.

## Cost model

| Component | Cost driver | At 1K users |
|---|---|---|
| Heartbeat tick | ~3K input + ~500 output tokens on Haiku | 1K × 3/day × $0.0008 = $2.40/day ≈ $75/month |
| Profile loads (reactive) | KV reads (~$0.50 per 1M reads) | Negligible |
| Postgres storage | ~20 MB across new tables + indexes | <$1/month |
| Cloudflare KV | <1 GB cached, low read volume | <$5/month |
| Total marginal cost of memory + heartbeat layer | | ~$80/month at 1K users |

Compared to reactive conversation costs (Sonnet/Opus, much higher per-call), the heartbeat layer is a small fraction of total agent spend. Worth it for the relational moat.

## Testing strategy

| Test | What it covers |
|---|---|
| `tests/agent/heartbeat.test.ts` | Per-outcome scenarios: HEARTBEAT_OK for quiet user, block update for active user, proactive event brief on Wednesday, followup trigger on schedule date, anomaly detection sends gentle check-in when consented |
| `tests/agent/memory.test.ts` | Cache hit + miss paths, block round-trip, MD content preservation, Chinese character preservation |
| `tests/jobs/heartbeat-scheduler.test.ts` | Due-user query correctness, active-hours boundary cases, paused user skipped, pause_until expiration auto-resumes, parallel dispatch via Promise.allSettled, 60s timeout |
| `tests/tools/user-commands.test.ts` | /profile rendering, /correct update flow, /pause + /resume, /delete me 2-step confirm + full data clearing |
| `tests/eval/heartbeat-quality.test.ts` | Eval suite: a fixture of 20 (profile, recent_messages, instructions) triples; assert the agent's chosen outcome and quality of generated block updates / proactive messages. Run via `npm run test:eval`. |

## Migration / rollout plan (Slice β; runs AFTER Slice α, BEFORE Slice 0.5)

1. **Add Postgres migrations 010-015.** All 6 new tables (including `pending_users` for onboarding handshake), RLS policies, indexes. Apply via Supabase MCP. (1 commit)
2. **Build memory.ts** with KV cache adapter for Cloudflare Workers KV. Add tests. (1 commit)
3. **Build heartbeat.ts** + 4 heartbeat tools. Add unit tests. (1 commit)
4. **Build heartbeat-scheduler.ts** + node-cron wiring in `src/index.ts`. Add scheduler tests. (1 commit)
5. **Decompose `prompts/master.md`** to include profile injection. Write `prompts/heartbeat.md`. (1 commit)
6. **Extend orchestrator.ts** (from Slice α) to load profile blocks alongside session state and inject them into the system prompt. Update orchestrator tests. (1 commit)
7. **Build user-commands.ts** + routing in `src/index.ts` for the 5 commands. Add tests. (1 commit)
8. **Build heartbeat preferences UI** in bia-roommate (`app/account/heartbeat/page.tsx`, `app/account/profile/page.tsx`). (1 commit)
9. **REMOVE the standalone Event Brief cron** if it was built during Slice α. Verify heartbeat now handles brief delivery. (1 commit)
10. **Update CLAUDE.md / README.md / AGENT.md.** Document memory + heartbeat layer. (1 commit)
11. **Backfill: write a one-time script that initializes empty profile blocks + default heartbeat config for all existing users.** Run once. (1 commit + manual execution)
12. **Tag the cutover.** `git tag v2.1.0-memory-heartbeat`.

Estimated total: 1.5-2 weeks for one focused engineer. Parallelizable with Slice 0.5 (different tables, different code paths).

## NOT in scope

- **Vector embeddings on profile blocks.** Always-loaded blocks remove the need for retrieval; if the volume of stuff worth remembering exceeds the 12 KB budget, revisit.
- **Long-term episodic memory (event log style).** The 6 fixed blocks are the spec. If you want episodic memory later, that's a separate design.
- **Cross-user memory ("who knows whom" social graph beyond the relationships block).** Out of scope; the `student_connections` table handles graph-level data outside this design.
- **Heartbeat-driven schema migrations.** Heartbeats are read-mostly + targeted writes; they don't restructure data.
- **Multi-language profile blocks (separate Mandarin + English).** Single MD-text per block; if the user writes in Mandarin, the block content reflects it. No translation/duplication.
- **Profile import from other platforms (LinkedIn, Instagram).** Out of scope.
- **Heartbeat-driven payment / billing actions.** george is free for August launch.
- **Federated profiles across schools.** Cross-school expansion is post-V2.

## Open questions

1. **Default cadence: 4h vs 6h vs 12h?** 4h gives more responsiveness for followups + anomaly detection. 12h reduces LLM cost ~3x. Recommend 4h to start, instrument cost, tune down if needed.
2. **Should `/profile` rendering be visible to the user verbatim (the MD content) or paraphrased?** Verbatim is more transparent but exposes implementation details. Recommend paraphrased ("here's what I know about you..." prose) with `/profile --raw` as the admin-mode verbatim view.
3. **What happens if Cloudflare KV is unavailable?** Fall back to Postgres direct; slower (~80ms vs 20ms) but functional. Log degradation to observability.
4. **Should heartbeat agent use a different LLM model than reactive agents?** Recommend yes — Haiku for heartbeats (cheap, fast, lower quality OK because heartbeat decisions are bounded), Sonnet/Opus for reactive (quality matters because user is waiting).
5. **Should there be an admin "see all heartbeats for user X" tool?** Useful for debugging. Recommend yes; expose via bia-admin at `/admin/users/[id]/heartbeats` showing the last 50 heartbeat_log rows.
6. **Should anomaly detection be opt-in or opt-out?** Recommend OPT-IN (`consent_anomaly_checkin=false` default). Opt-in respects user agency; opt-out feels invasive.
7. **What's the rule for when to update a block vs leave it?** Recommend heartbeat prompt instruction: "Only update a block when there is meaningful new information that changes the user's profile in a way an outsider would notice. Trivial rephrasing is not an update."

## Acceptance criteria

The memory + heartbeat layer is complete when:

- All 6 new migrations are applied to prod via Supabase MCP, schemas match the spec.
- `user_profiles`, `user_heartbeat_config`, `user_heartbeat_instructions`, `heartbeat_log`, `student_followups` tables have RLS enabled with the spec'd policies.
- `npm test` passes all new test files (heartbeat.test.ts, memory.test.ts, heartbeat-scheduler.test.ts, user-commands.test.ts).
- `npm run test:eval` passes the heartbeat eval suite (correct outcomes on 18 of 20 fixtures).
- A heartbeat tick on a test user completes in <30s p95 (verified via log table).
- A reactive turn loads profile in <100ms p95 (verified via observability).
- The 5 control commands (`/profile`, `/correct`, `/pause`, `/resume`, `/delete me`) work end-to-end for at least one test user.
- The Event Brief from the orchestrator spec is now delivered via heartbeat (no standalone cron in production).
- Heartbeat dispatch never exceeds 1 proactive message per user per tick (verified by rate-limit test).
- Heartbeat never fires during user's pause window or outside active hours (verified by scheduler test).
- bia-roommate's `/account/heartbeat` and `/account/profile` pages work and update Postgres + invalidate KV.
- CLAUDE.md, README.md, AGENT.md describe the memory + heartbeat layer.
- A real user round-trip works on staging: complete onboarding, profile is initialized, heartbeat fires within 4h, profile gets an update, user runs `/profile` and sees the update, user runs `/delete me` and all data is cleared.

## Cross-references

- Office-hours design doc: `~/.gstack/projects/george/mac-design-george-v2-20260607-175231.md`
- Orchestrator + 3 intent agents (Slice α): `docs/superpowers/specs/2026-06-07-orchestrator-3-intent-agents-design.md`
- Reality-aware roadmap: `docs/superpowers/plans/2026-06-07-roadmap-v2-reality-aware.md`
- Migrations reconcile (Slice 0.5): `docs/superpowers/plans/2026-06-07-slice-0.5-migrations-reconcile.md`
- OpenClaw heartbeat reference: https://docs.openclaw.ai/gateway/heartbeat
- MemGPT / Letta paper + docs (for the Letta-style core memory block lineage): https://research.memgpt.ai
