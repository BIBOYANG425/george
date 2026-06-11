# george (george-api.uscbia.com)

@AGENT.md

## What this repo is

The AI agent backend for BIA. An Express server (Node 20+) that runs George Tirebiter, BIA's bilingual AI companion for USC international students. Lives on three platforms:

- **Web chat** at https://uscbia.com/george/chat → POST `/chat` (relayed via `/api/george/chat` in bia-roommate)
- **iMessage** (private beta, Mac-host only) via `@photon-ai/imessage-kit`
- **WeChat Official Account** (coming next) via the XML webhook adapter

The full persona, voice fingerprint, sub-agent split, and domain rules live in `AGENT.md` and `prompts/master.md`. Read those before changing how George talks. Voice is the product here, not the wiring.

## What this repo is NOT

- **Not a Next.js project.** Express only. No SSR, no JSX, no `app/`.
- **Not a place for user-facing pages.** The `/george` marketing page and `/george/chat` UI live in bia-roommate. This repo serves an HTTP API.
- **Not the Supabase schema owner.** Migrations live in bia-admin/supabase/migrations. This repo reads from and writes to existing tables (`students`, `messages`, `reminders`, `events`).
- **Not cloud-friendly out of the box.** The iMessage adapter requires macOS + Full Disk Access. To deploy to Fly.io or Railway, set `IMESSAGE_ENABLED=false` and accept that iMessage stops working in that instance.

## The BIA platform (3 repos)

```
BIBOYANG425/bia-roommate           uscbia.com
  Next.js + Vercel. Landing + 新生services
  + blog + George UI pages + Chrome extension.
                │
                │  POST /api/george/chat
                │  (relay through tunnel)
                ▼
BIBOYANG425/george                 george-api.uscbia.com (planned)
  Express + Node. Agent backend.
  Built on @anthropic-ai/claude-agent-sdk:
  Orchestrator + 3 sub-agents, 23 tools,
  Supabase memory, WeChat + iMessage adapters,
  scrapers, cron jobs. This repo.

BIBOYANG425/bia-admin              admin.uscbia.com
  Next.js + Vercel. Officer dashboard.
  Owns supabase/migrations and the
  @biboyang425/bia-shared package.
```

The relay in bia-roommate forwards to `GEORGE_BACKEND_URL` (Cloudflare quick tunnel today, named tunnel at `george-api.uscbia.com` planned). The contract is:

- Request: `POST /chat` with `Authorization: Bearer $ADMIN_TOKEN`, body `{ userId, platform: 'imessage' | 'wechat', text }`.
- Response: `{ response: string }` or `{ error: string }`.

If you change either side of that contract, the matching change goes in bia-roommate the same day.

## Dual-mode iMessage (Mac mini bridge + iPhone Shortcuts fallback)

Production runs the agent backend on a Cloudflare Container (outside the China firewall) and iMessage on a Mac in China. The connection between them is one of two paths, switchable by env vars on the China side.

```text
                Cloudflare Container (agent backend)
                ─────────────────────────────────────
                  IMESSAGE_ENABLED=false
                  BACKEND_RELAY_URL=  (unset)
                  ANTHROPIC_API_KEY, SUPABASE_*, …
                  ADMIN_TOKEN_PHONE (only if serving Path B)
                ▲                                          ▲
                │ POST /chat (Mac mini, Path A)            │ POST /imessage/incoming (iPhone, Path B)
                │ bearer ADMIN_TOKEN                       │ bearer ADMIN_TOKEN_PHONE
                │                                          │
   ┌────────────┴───── Path A ──────┐         ┌────────────┴───── Path B ──────┐
   │ Mac mini in China               │         │ iPhone in China                 │
   │   IMESSAGE_ENABLED=true         │         │   Apple Shortcuts:              │
   │   BACKEND_RELAY_URL=<container> │         │   - "When I receive a message"  │
   │   ADMIN_TOKEN=<matches above>   │         │     POSTs to /imessage/incoming │
   │   Photon SDK reads iMessage     │         │   - Personal Automation every   │
   │   from the paired iPhone        │         │     1m polls /imessage/outgoing │
   │                                 │         │     and sends via Messages.app  │
   └─────────────────────────────────┘         │   - ack /imessage/outgoing/:id  │
                                                │     after each send             │
                                                └─────────────────────────────────┘
```

**Path A (Mac mini bridge)** is the production-grade target. ~10s round-trip end-to-end. Single bearer hop. No queue. Same flow as today's George.

**Path B (iPhone Shortcuts)** is the no-Mac interim. Outgoing latency up to 60 seconds (the polling cadence). Personal Automation reliability has gaps. Use until the Mac mini arrives, then switch by disabling the iOS automations and starting the Mac mini bridge process.

Switch between the two by what's running on the China side:

| Running | Path active | Switch by |
|---|---|---|
| iPhone Shortcuts enabled, no Mac bridge | Path B | iOS Settings → Shortcuts → enable/disable Personal Automation |
| Mac mini `npm run dev` with `BACKEND_RELAY_URL` set | Path A | pm2 start/stop the bridge process |
| Both | Don't do this — double replies | Disable the iPhone Shortcuts before starting the Mac mini |

The Container always exposes both endpoint sets, so swapping doesn't require redeploying the backend.

## How to run locally

```bash
npm install
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, KIMI_API_KEY, APIFY_TOKEN,
# GOOGLE_MAPS_API_KEY, ADMIN_TOKEN
npm run dev
```

Health check:
```bash
curl http://localhost:3001/health
# → {"status":"ok","character":"George — BIA 学长","tools":24}
```

Chat test (replace `$TOKEN` with your `ADMIN_TOKEN`):
```bash
curl -X POST http://localhost:3001/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"dev","platform":"imessage","text":"hi 学长"}'
```

### Running with iMessage

1. macOS Sequoia or later
2. iMessage signed in
3. Grant Full Disk Access to the node binary (System Settings → Privacy & Security → Full Disk Access → add `/opt/homebrew/bin/node` or your local node binary)
4. Set `IMESSAGE_ENABLED=true` in `.env`
5. `npm run dev` — the adapter starts watching the iMessage db on disk

### Running for web chat only (no iMessage)

1. `IMESSAGE_ENABLED=false`
2. Start a Cloudflare tunnel: `cloudflared tunnel --url http://localhost:3001`
3. Take the printed `*.trycloudflare.com` URL and set it as `GEORGE_BACKEND_URL` on bia-roommate's Vercel project
4. Set the same `ADMIN_TOKEN` value as `GEORGE_ADMIN_TOKEN` on Vercel
5. uscbia.com/george/chat now relays here

## How to deploy

**Mac-host (today's mode):** run on Bobby's Mac with `npm run dev` plus a `cloudflared` quick tunnel. iMessage works. Web chat works. Mac sleep or `cloudflared` exit = chat returns the fine-tune fallback message.

**Cloud (planned):** deploy via the included `Dockerfile` to Fly.io or Railway. Set `IMESSAGE_ENABLED=false`. Web chat works in the cloud. iMessage continues on the Mac as a parallel instance pointing at the same Supabase.

**Named tunnel (planned):** `cloudflared tunnel create george-api` + DNS CNAME at `george-api.uscbia.com` once the Cloudflare DNS migration finishes. Replaces the rotating quick-tunnel URL with a stable hostname.

## Agent architecture (Slice α — Claude Agent SDK)

george runs on `@anthropic-ai/claude-agent-sdk`. One orchestrator + three intent sub-agents.

- **Orchestrator** (`src/agent/orchestrator.ts`): single `query()` call. Routes to sub-agents via Agent SDK's description-based dispatch. Holds 2 direct tools (`set_reminder`, `load_skill`) + conversation state via `sessionStore`.
- **Find People sub-agent**: matching / squad mode (3 tools: lookup_student, update_profile, suggest_connection).
- **What's Happening sub-agent**: events + places (4 tools: search_events, submit_event, get_event_details, travel_time).
- **Know Things sub-agent**: USC knowledge (14 tools: courses, professors, programs, housing).

All 4 agents inherit `prompts/master.md` (george's voice + anti-fabrication + refusal categories), then append a specialization prompt (`prompts/orchestrator.md`, `prompts/find-people.md`, `prompts/whats-happening.md`, `prompts/know-things.md`).

Conversation state persists via `src/agent/session-store.ts` (Supabase-backed SessionStore): `messages` + `student_memories` tables.

Spec: `docs/superpowers/specs/2026-06-07-orchestrator-3-intent-agents-design.md`.

## Guardrails

- **Persona is the product.** The rules in `AGENT.md` are non-negotiable. Read it before editing `prompts/master.md` or `src/agent/bia-lore.ts`. The founder voice was distilled from real WeChat messages. Don't smooth it out.
- **No invented facts.** Course numbers, professor names, event dates, prices. If George doesn't know, he says "戳到知识盲区了😢" and uses a tool.
- **Tool registration is declarative.** Every new tool file must be listed in `src/tools/index.ts` and wired into `src/agent/agents.config.ts`. The Agent SDK's dispatch is automatic; you define tools and the orchestrator routes them.
- **Supabase service-role key has full DB access.** Use it only inside `src/db/*` helpers. Never expose via HTTP. Never log it.
- **Rate limit on /chat.** 10 messages per minute per `userId` via the LRU cache in `src/adapters/rate-limiter.ts`. Don't bypass.
- **Injection filter at the door.** `checkInjection()` runs on every message before anything else. Don't skip.
- **Admin token gate on `/chat`.** Requires `Authorization: Bearer $ADMIN_TOKEN`. Never log the token or echo it in error responses.
- **Mac-only code stays env-gated.** Anything Photon SDK related sits behind `if (config.imessageEnabled)`. The cloud deploy depends on this. Importing the Photon SDK unconditionally breaks `npm install` on Linux.
- **Onboarding gates all other features.** Until the 4 profile fields (major, year, sleep habit, social visibility) are set, sub-agents return the onboarding prompt. Don't bypass.

## Cross-repo coordination

Changes here that require coordinated changes:

- **`/chat` request or response shape** → matching change in bia-roommate's `/api/george/chat` relay route.
- **New Supabase table or column** → schema migration goes in bia-admin first. George only reads or writes existing tables.
- **New env var George reads** → update `.env.example` here, update deploy docs, update Bobby's Mac `.env`, and if it's required for web chat too, set it on bia-roommate's Vercel project.
- **Behavioral changes that visitors will notice** (new tools, new sub-agent behavior, persona shifts) → ping Bobby. Web chat hits real users.

## Memory + heartbeat layer (Slice β)

george has per-user long-term memory via 6 markdown blocks (identity, academic, interests, relationships, state, george_notes) stored in the `user_profiles` Postgres table. Profile blocks are loaded into every agent's system prompt at conversation start via Cloudflare KV cache (5-min TTL, target <100ms load).

A scheduled heartbeat fires per user every 12h during their active hours (default 09:00-22:00 LA). Each tick is an isolated `callLLM` call on DeepSeek-V3 with 4 tools available: `update_block`, `send_proactive_message`, `add_followup`, `heartbeat_ok`. Most ticks return HEARTBEAT_OK. Occasional ticks update memory or send proactive messages (Event Brief, followups, anomaly check-ins for opted-in users).

Subsumes the Event Brief cron from Slice α (Event Brief was already skipped during Slice α planning per spec deviation). Onboarding (Slice B) writes the initial 3-table contract: `user_profiles` (form data), `user_heartbeat_config` (cadence + consents), `user_heartbeat_instructions` (initial standing doc).

Key files:
- `src/memory/profile.ts` — ProfileStore: 6 blocks, load/save, KV cache
- `src/memory/instructions.ts` — InstructionsStore: standing instructions doc
- `src/memory/kv-cache.ts` — Cloudflare KV adapter + in-memory fallback
- `src/agent/heartbeat.ts` — runHeartbeat() per-user isolated handler
- `src/agent/llm-clients.ts` — DeepSeek-V3 client (heartbeats) + interface for Anthropic (reactive)
- `src/jobs/heartbeat-scheduler.ts` — node-cron every 10 min, dispatches due users
- `src/tools/heartbeat/` — 4 heartbeat-only tools
- `src/tools/user-commands.ts` — 5 user control commands routed before orchestrator

User control commands (iMessage): `/profile`, `/correct <block> <content>`, `/pause [N days]`, `/resume`, `/delete me`. Web settings hub at `uscbia.com/account/george` (companion bia-roommate PR #64).

Spec: `docs/superpowers/specs/2026-06-07-memory-heartbeat-profiles-design.md`.

## Onboarding handshake (Slice B)

The web landing (uscbia.com/george) mints a 6-char code into `pending_users` and prefills an `sms:` message. When that message arrives, george intercepts it before the orchestrator on both iMessage paths and replies with a 3-message greeting (greeting + vcf contact card, intro + 5-image showcase, profile link).

Two accepted formats, with different miss behavior:

- **Legacy** `<code>-START`: unambiguous. A lookup miss replies "couldn't find that code".
- **Natural** `...george (<code>)...`: can false-positive on real sentences ("ask george (senior) about housing"). A lookup miss falls through to the orchestrator silently. Never reply with a code error for this format.

Attachments differ per path. Path A (Mac bridge) sends local file paths via `sdk.send`, resolved to absolute. Path B (iPhone Shortcuts) cannot read this host's filesystem, so paths are rewritten to public URLs under `ONBOARDING_ASSET_BASE_URL` before enqueueing; if that var is unset, Path B handshakes go out text-only. The assets (5 showcase PNGs + `george.vcf` from `assets/onboarding/`) must be hosted at that URL base (bia-roommate `public/` or Supabase Storage).

Profile completion is owned by bia-roommate's form (`app/george/profile/api/submit/route.ts`), which flips `pending_users.status` to `completed`. A daily cron (03:00 LA, gated by `ONBOARDING_ENABLED`) purges rows still in `pending` status after 14 days; completed rows are kept so returning users get "you're already in".

Env vars: `ONBOARDING_PROFILE_URL_BASE`, `ONBOARDING_ASSET_BASE_URL`, `ONBOARDING_ENABLED`, `GEORGE_IMESSAGE_PHONE` (see `.env.example`). Cross-repo: the queue's attachment columns live in bia-admin migration `20260608000001_imessage_outgoing_attachments`, and the deployed iPhone Shortcut must be updated to read `images`/`files` URLs from `/imessage/outgoing` rows.

## Persona source map

For voice and persona edits, see the "Prompt source map" section in `AGENT.md`. All voice changes go through `prompts/master.md` and `src/agent/bia-lore.ts`. The orchestrator in `src/agent/orchestrator.ts` is wiring (routing, tool dispatch, conversation memory). Voice does not belong there.

## Skill routing

When the user's request matches an available skill, use that skill's workflow before
answering directly. Persona work especially benefits from `/superpowers:brainstorming`
before code touches `personality.ts`.

Key routing rules:

- Persona / voice changes, "George doesn't sound right" → invoke brainstorming, then edit `prompts/master.md`
- Bugs, "why isn't this tool firing", 500 errors → invoke investigate
- New tool design → invoke office-hours first
- Architecture or new sub-agent → invoke plan-eng-review
- Ship, deploy, create PR → invoke ship
