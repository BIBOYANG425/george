# George

> The AI senior you never met in person, always online and living in your iMessage. George knows USC cold. Where to eat, which matcha is worth the walk, which party is actually worth your night, and which people you would genuinely click with. One text and the right answer comes back in seconds, any hour.

George is built by [BIA (Bridging Internationals Association)](https://uscbia.com), a 1,500+ member international student community at USC. He is bilingual (中文 / English) and he brings a curated USC experience straight to your iMessage, the app you already use all day. Text him the way you would text the one senior who always knows. He does three things, and he does each one the way a real senior would.

## What George does

### 1. Your USC brain, on call

Ask George anything about USC and get the answer a senior would actually give you. Where to eat near campus, which matcha spot is worth the walk, which professor and section to take, how to pay tuition without the $100 Flywire fee, which meal plan to skip. He recommends down to the specifics, and he points you to the dorms, dining, and study spots worth your time.

He knows where you are. Text "is the library safe to walk back from at 11pm" and George checks the real DPS patrol zones, the free share-Lyft hours, the walk time, and the distance before he answers.

And he never makes things up. No invented course numbers, professor names, or prices. When George hits a blank, he says "戳到知识盲区了😢" and looks it up with a tool.

### 2. He introduces you to people worth meeting

George is a social network that does the introducing for you. He learns what you are actually into, finds the handful of people you would genuinely click with, and makes the introduction himself. The match is built on real overlap, like both of you up at 1am or both grinding the same Lyon 8pm seminar, rather than "you're both CS majors."

You stay in control. George shares your handle or schedule only when you opt in, and he leans toward a four or five person table over a 30-person mixer.

### 3. The events worth your time, brought to you

George knows which party is actually worth your night, and he brings the right BIA event straight to you. He surfaces what fits, a city walk, a pool party, an industry deep-talk, a hackathon, caps it at two so it never reads as spam, and skips the stand-on-stage-for-20-minutes mixers nobody enjoys.

This is also BIA's most direct line to you. One message, personal, at the moment it matters, sent by someone who already knows what you are into.

## Why George is different

Most campus AI is a GPT wrapper with a system prompt that says "You are a helpful assistant for X University." George is built the other way around.

- **Voice distilled from real WeChat messages.** The founder of BIA spent years organizing on WeChat. George's persona, idioms, register, and emoji palette come from those actual messages. He does not sound like a chatbot because he is not trying to be one.
- **Three pillars, three agents.** The three things above run on one orchestrator and three intent sub-agents (Know Things, Find People, What's Happening) built on `@anthropic-ai/claude-agent-sdk`. Each has scoped tools, voice calibration, and domain rules, and the orchestrator routes via description-based dispatch.
- **Anti-fabrication by design.** George does not invent course numbers, professor names, event dates, or prices. When he does not know, he says so and uses a tool.
- **Geolocation he can reason about.** Distance, walk time, DPS patrol zones, and free share-Lyft hours come from math over verified coordinates, never a guess.
- **Calendar-aware moods.** During finals week George is grumpy and terse. During orientation he is warm. His mood tracks the real USC academic calendar.
- **Section-level course advice.** Not "CSCI 102 is a good intro class." George knows BUAD 280 Sweeney runs 200-question 90-minute exams, that writ150 quality varies more by professor than by topic, and to default to RMP 5.0 professors, surfacing the highest available rating when none clear 4.0.

## Live where students already are


| Platform                                                             | Status       | Reach                                                    |
| -------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| Web chat at [uscbia.com/george/chat](https://uscbia.com/george/chat) | Beta         | Public preview, no login                                 |
| iMessage                                                             | Private beta | [Join the waitlist](https://forms.gle/qZfbiKdmasN6jid5A) |
| WeChat Official Account                                              | Coming next  | BIA's 3,500+ existing followers                          |


## Architecture at a glance

```
[Web]                  [iMessage]                  [WeChat]
  │                       │                           │
  │ uscbia.com            │ cloud sync                │ XML webhook
  │ relay                 │ (no Mac needed)           │
  ▼                       ▼                           ▼
┌────────────────────────────────────────────────────────────┐
│ Express server (this repo)                                 │
│                                                            │
│   POST /chat                                               │
│     │                                                      │
│     ▼                                                      │
│   rate-limit ──► injection filter ──► student lookup       │
│                                          │                 │
│                                          ▼                 │
│   orchestrator (Agent SDK) ──► sub-agent dispatch          │
│   + routing ──► sub-agent loop (up to 12 tool             │
│                  calls per turn) ──► memory               │
│                  extraction (async) ──► response           │
└────────────────────────────────────────────────────────────┘
        │                       │                  │
        │ Claude Sonnet 4.6     │ Supabase         │ Apify
        │ + prompt caching      │ + pgvector RAG   │ + Google Maps
        ▼                       ▼                  ▼
   Anthropic API           students, messages,   Instagram scraper,
                           reminders, events,    USC calendar
                           campus knowledge
```

## Memory + heartbeat layer (Slice β)

george builds and maintains a long-term memory profile for each student: 6 markdown blocks (identity, academic, interests, relationships, state, george_notes) stored in Postgres and cached via Cloudflare KV for fast loads on every turn. Profile blocks are automatically injected into each agent's system prompt.

A background heartbeat scheduler fires per user every 12 hours during their active hours (default 09:00-22:00 LA). Each tick uses DeepSeek-V3 with 4 tools — `update_block`, `send_proactive_message`, `add_followup`, `heartbeat_ok` — to review recent context and decide whether anything needs attention. Most ticks return HEARTBEAT_OK (silence). Occasional ticks update a profile block or send a proactive nudge (event briefs, due followups, silence check-ins for opted-in users).

Students control george's behavior via five iMessage commands (`/profile`, `/correct`, `/pause`, `/resume`, `/delete me`) or via the web settings hub at `uscbia.com/account/george`.

Spec: `docs/superpowers/specs/2026-06-07-memory-heartbeat-profiles-design.md`.

## Quick start

Requires Node 20+. macOS for iMessage; any OS for web chat only.

```bash
git clone https://github.com/BIBOYANG425/george.git
cd george
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
# → {"status":"ok","character":"George — BIA 学长","tools":32}
```

Quick chat (replace `$TOKEN` with your `ADMIN_TOKEN` value):

```bash
curl -X POST http://localhost:3001/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"dev","platform":"imessage","text":"hi 学长"}'
```

For deeper setup (iMessage Full Disk Access, Cloudflare tunnel, cloud deploy without iMessage), see [CLAUDE.md](CLAUDE.md).

## Dual-mode iMessage

Production runs in two modes off the same codebase, switched by env vars:

**Mode 1 — Agent backend (Cloudflare Container, Vercel function, or local dev).** Runs the full agent loop: orchestrator dispatch to sub-agents, tools, Supabase, Anthropic. Required env: `ANTHROPIC_API_KEY`, `SUPABASE_`*, `ADMIN_TOKEN`. Optional: `ADMIN_TOKEN_PHONE` if serving the iPhone Shortcuts (Path B) endpoints. `IMESSAGE_ENABLED=false` so it doesn't try to open Photon on a Linux container.

**Mode 2 — iMessage bridge (Mac mini in China).** Runs ONLY the iMessage adapter. Reads new iMessages via Photon SDK, POSTs each to the agent backend's `/chat`, sends the response back via SDK. Required env: `IMESSAGE_ENABLED=true`, `BACKEND_RELAY_URL=https://your-backend`, `ADMIN_TOKEN=<must match backend>`. Does NOT need Anthropic / Supabase / Maps keys — config.ts skips those required-checks when `BACKEND_RELAY_URL` is set.

If you don't have a Mac yet, the agent backend also exposes a Path B set of endpoints that a dedicated iPhone running Apple Shortcuts can drive:

- `POST /imessage/incoming` — iPhone Personal Automation "When I receive a message" POSTs `{sender, text}` here
- `GET /imessage/outgoing` — iPhone polls every minute, gets pending replies queued in Supabase
- `POST /imessage/outgoing/:id/ack` — iPhone confirms each reply was sent

All three are gated by `ADMIN_TOKEN_PHONE`. Outgoing latency under this mode is up to 60 seconds (the polling cadence), so Path A (Mac mini) is the production-grade target. Path B is the no-Mac interim.

See [CLAUDE.md](CLAUDE.md) for the full topology + deploy steps.

## Repo structure

```
src/
  agent/                  Orchestrator, sub-agents, session state
    orchestrator.ts       Agent SDK orchestrator + direct tools (set_reminder, load_skill)
    agents.config.ts      Sub-agent definitions + tool routing
    session-store.ts      Supabase-backed conversation memory
    bia-lore.ts           USC locations, neighborhoods, signature phrases, anti-patterns
  prompts/                Shared + specialized voice prompts
    master.md             Shared identity (loaded into all 4 agents)
    orchestrator.md       Routing logic
    find-people.md        Squad mode rules
    whats-happening.md    Events + places
    know-things.md        USC knowledge
  tools/                  30+ callable tools (search_events, get_course_reviews, distance_compare, ...)
  db/                     Supabase helpers (students, messages, reminders, events)
  adapters/               WeChat (XML webhook), iMessage (cloud transport), rate-limiter, send-message
  scrapers/               Instagram (Apify), USC calendar (iCal)
  skills/                 Skill registry (loaded per-conversation)
  security/               Injection filter, automated message filter
  observability/          Structured logger + /stats endpoint
  jobs/                   Memory extraction, proactive matching, reminder sender
data/
  usc-calendar.json       Drives the mood system (finals, orientation, breaks)
scripts/                  CLI utilities (catalogue ingest, WeChat ingest, etc.)
tests/                    Vitest suite
```

## Tech stack

- **Runtime:** Node 20+, TypeScript, Express
- **LLM:** Claude Sonnet 4.6 via `@anthropic-ai/sdk` with prompt caching. Kimi / Moonshot for lightweight ops (classification, memory extraction).
- **Database:** Supabase (Postgres) with pgvector for campus knowledge RAG.
- **Platforms:** iMessage as the primary channel (cloud delivery, no Mac required, with a legacy self-hosted fallback), a WeChat Official Account (XML webhook + async customer-service API), and web chat.
- **Scrapers:** Apify Instagram actor, iCal parser for USC calendar.
- **Maps:** Google Maps Platform (Geocoding, Places, Routes).
- **Tests:** Vitest.
- **Deploy:** Cloud-hosted backend, always online, via a multi-stage Dockerfile. A legacy self-hosted Mac path stays available behind env flags.

## Sister repos

George is part of a 3-repo BIA platform. The other two:

- **[bia-roommate](https://github.com/BIBOYANG425/bia-roommate)** → uscbia.com. Public Next.js site. Landing, 新生services (roommate matching, course planner, course rating, sublet, squad, shipping, blog), George marketing + chat UI, Chrome extension. Relays to this repo at `/api/george/chat`.
- **[bia-admin](https://github.com/BIBOYANG425/bia-admin)** → admin.uscbia.com. Officer dashboard. Hosts `@biboyang425/bia-shared` (types + Supabase clients) and the canonical Supabase migrations.

Network boundary: uscbia.com's relay forwards to `GEORGE_BACKEND_URL` (the cloud backend today, named tunnel at `george-api.uscbia.com` planned).

## Contributing

See [CLAUDE.md](CLAUDE.md) for the full guardrails. Short version:

- **Persona is the product.** Read [AGENT.md](AGENT.md) before editing `prompts/master.md` or `src/agent/bia-lore.ts`. The voice rules are non-negotiable.
- **No invented facts.** Course numbers, professor names, event dates, prices. If George does not know, he says so and uses a tool.
- **Tool registration is declarative.** Add the new tool to `src/tools/index.ts` and wire it into `src/agent/agents.config.ts`. The Agent SDK handles dispatch.
- **Mac-only code stays env-gated.** Anything Photon SDK related sits behind `if (config.imessageEnabled)`. Cloud deploy depends on this.

## Built by

[BIA (Bridging Internationals Association)](https://uscbia.com) at USC. 1,500+ international students, 3,500+ social followers, 80+ vetted cohort fellows, 15+ events per year. Founded 2024.

## License

TBD. The repo is currently private; license to be added before any open-source release.