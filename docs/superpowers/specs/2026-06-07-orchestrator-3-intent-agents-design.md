# george Agent Redesign: Orchestrator + 3 Intent Agents on Claude Agent SDK

**Date:** 2026-06-07
**Status:** DRAFT (pending user review)
**Brainstormed via:** `/superpowers:brainstorming` 2026-06-07
**Implements:** the "rethink multi-agent system + features" pivot from `~/.gstack/projects/george/mac-design-george-v2-20260607-175231.md`

## Goal

Replace george's current 5 subject-domain sub-agents (event / course / housing / social / campus) with a hierarchical 4-agent system on Claude Agent SDK: one orchestrator + three intent agents (Find People / What's Happening / Know Things) + one shared master prompt. Move the agent core from custom orchestration code (`intent-classifier.ts` + `tool-executor.ts` + `tool-registry.ts` + `context-window.ts`) onto `@anthropic-ai/claude-agent-sdk`'s native primitives. Add the first proactive feature (Event Brief cron with per-user daily-or-weekly cadence) as a parallel job that calls into the What's-Happening agent.

The motivation, verified during brainstorming, is that all four current pains hurt simultaneously: (1) the 5 subject-domain sub-agents are categorized wrong for how students actually ask questions, (2) the 24 tools are bloated and unevenly used, (3) the 46 KB `personality.ts` is a monolith that makes voice work risky, (4) features don't line up with the "connection" core that george is FOR.

This spec covers ONLY the agent core redesign + Event Brief feature. The downstream Slice 0.5 (migrations reconcile) and Slices A–F in `docs/superpowers/plans/2026-06-07-roadmap-v2-reality-aware.md` remain valid. This work becomes a foundational Slice α that lands before Slice 0.5.

## Architecture

```
                         INCOMING MESSAGE (web, iMessage, WeChat)
                                       │
                                       ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  ORCHESTRATOR AGENT                                          │
   │  ──────────────────                                          │
   │  System prompt = master_prompt + orchestrator_prompt         │
   │                                                              │
   │  Tools (sub-agents-as-tools, via Agent SDK's built-in Agent):│
   │    • Agent("find-people", query)                             │
   │    • Agent("whats-happening", query)                         │
   │    • Agent("know-things", query)                             │
   │    • Plus orchestrator-direct tools:                         │
   │        - set_reminder, load_skill, search_helpers            │
   │                                                              │
   │  Decides:                                                    │
   │    - Which sub-agent(s) to call                              │
   │    - Whether multi-agent collaboration is needed             │
   │    - Whether to answer directly (small-talk, refusal)        │
   │  Holds:                                                      │
   │    - Conversation state (via sessionStore -> Supabase)       │
   │    - Calendar mood (finals → grumpy, orientation → warm)     │
   └──────────────────────────────────────────────────────────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  ▼                    ▼                    ▼
      ┌───────────────────┐   ┌──────────────────┐   ┌─────────────────┐
      │  FIND PEOPLE      │   │  WHAT'S HAPPENING│   │  KNOW THINGS    │
      │  (reactive only)  │   │  (reactive +     │   │  (reactive)     │
      │                   │   │   proactive)     │   │                 │
      │  System prompt =  │   │                  │   │                 │
      │   master_prompt   │   │  System prompt = │   │  System prompt =│
      │   + find_people_  │   │   master_prompt  │   │   master_prompt │
      │   prompt          │   │   + whats_happen │   │   + know_things │
      │                   │   │   ing_prompt     │   │   prompt        │
      │  Tools:           │   │  Tools:          │   │  Tools (~13):   │
      │  • squad_find     │   │  • search_events │   │  • campus_      │
      │  • suggest_       │   │  • submit_event  │   │    knowledge    │
      │    connection     │   │  • places        │   │  • freshman_faq │
      │  • lookup_student │   │  • get_event_    │   │  • describe_    │
      │  • update_profile │   │    details       │   │    course       │
      │                   │   │  • event_brief_  │   │  • recommend_   │
      │                   │   │    generator NEW │   │    courses      │
      │                   │   │  • instagram_    │   │  • get_rmp_     │
      │                   │   │    scraper       │   │    ratings      │
      │                   │   │                  │   │  • search_      │
      │                   │   │                  │   │    courses      │
      │                   │   │                  │   │  • search_      │
      │                   │   │                  │   │    programs     │
      │                   │   │                  │   │  • plan_        │
      │                   │   │                  │   │    schedule     │
      │                   │   │                  │   │  • get_student_ │
      │                   │   │                  │   │    academic_    │
      │                   │   │                  │   │    state        │
      │                   │   │                  │   │  • course_tips  │
      │                   │   │                  │   │  • search_      │
      │                   │   │                  │   │    roommates    │
      │                   │   │                  │   │  • search_      │
      │                   │   │                  │   │    sublets      │
      │                   │   │                  │   │  • post_sublet  │
      └───────────────────┘   └──────────────────┘   └─────────────────┘
                                       │
                              ┌────────┴─────────┐
                              ▼                  ▼
                     EVENT BRIEF CRON       LIVE EVENT
                     (NEW)                  SEARCH (existing)
                     node-cron, per user:
                     • Daily  → 08:00 LA
                     • Weekly → Wed 08:00 LA
                     Calls query() per user
                     with promp matching
                     What's-Happening agent
                     spec.
```

The orchestrator is a single `query()` call configured with `agents: { ... }`. Claude's Agent SDK auto-routes via each sub-agent's `description` field, plus the orchestrator can explicitly name an agent in its own reasoning (e.g., "use the find-people agent to look up Sarah"). Sub-agents run in fresh contexts; only the prompt string the orchestrator passes reaches them. Each sub-agent's response returns to the orchestrator as an Agent tool result.

The master prompt is the ONE source of truth for george's identity: ghost-dog mascot, lowercase 学长 voice, no fabrication, calendar mood overlay, BIA editorial brand. Each agent inherits the master + appends its own specialization. If george's voice evolves, change `prompts/master.md` once and all four agents inherit.

## Components

### Files to CREATE

- `src/agent/orchestrator.ts` — replaces `intent-classifier.ts`. Single `runOrchestrator(userId, platform, text)` function that builds the `query()` call with the orchestrator system prompt + agents config + sessionStore + maxTurns. Returns an async iterator the caller streams.
- `src/agent/agents.config.ts` — exports the `agents:` object literal mapping `find-people | whats-happening | know-things` to their `{ description, prompt, tools }` configs. Single source of truth for which agent owns which tools.
- `src/agent/session-store.ts` — implements Agent SDK's `SessionStore` interface against Supabase. Reads from `messages` + `student_memories` on session start; writes turn results back on session end. Keeps the existing schema; no migration.
- `prompts/master.md` — george's shared identity. Decomposed from `personality.ts` (the parts that apply to every interaction: voice rules, refusal patterns, calendar mood, brand identity).
- `prompts/orchestrator.md` — orchestrator-specific specialization (routing logic, multi-agent rules, proactivity decisions, when to answer directly).
- `prompts/find-people.md` — Find People specialization (squad mode tone: "hey i think you'd hit it off with X for Y," NOT romantic, interest-based only).
- `prompts/whats-happening.md` — What's Happening specialization (event surfacing + spatial recommendations with DPS overlay + proactive Event Brief tone).
- `prompts/know-things.md` — Know Things specialization (USC-knowledge answering, source citation, "戳到知识盲区了😢" refusal).
- `src/jobs/event-brief-cron.ts` — node-cron job that queries `user_brief_preferences` table for users due today/this Wednesday, calls `query()` against the What's-Happening agent with a brief-generation prompt, sends the output via the existing iMessage/web adapters.
- `src/tools/event-brief-generator.ts` — new Zod-typed tool registered to the What's-Happening agent. Given a user's interests + recent activity + the next 7 days of events, returns a 3-5 event ranked brief.
- `supabase/migrations/009_user_brief_preferences.sql` — new table `user_brief_preferences (user_id PK, cadence enum('off','daily','weekly_wed'), categories text[], last_sent_at, paused)`.
- `tests/agent/orchestrator.test.ts` — full agent-loop tests via `query()`. Covers: reactive squad request routes to find-people, reactive event search routes to whats-happening, reactive knowledge question routes to know-things, multi-agent question routes to two sub-agents in sequence, off-scope question gets direct refusal.
- `tests/jobs/event-brief-cron.test.ts` — cron logic tests: user with cadence=off skipped, user with cadence=daily and last_sent_at>24h ago sent, user with cadence=weekly_wed and today=Wednesday and last_sent_at>6d ago sent, paused user skipped.
- `tests/tools/event-brief-generator.test.ts` — eval-style test against a small golden set of brief inputs.

### Files to MODIFY

- `src/index.ts` — replace the existing call into `processMessage()` (from the custom tool-executor) with `runOrchestrator()`. The HTTP route handlers (`/chat`, `/imessage/incoming`) stay; only what they call changes.
- `src/db/student-memories.ts` (and any other Supabase access helpers) — keep as-is; called from the new sessionStore implementation.
- `src/tools/*.ts` — each existing tool gets rewrapped to use `tool()` from `@anthropic-ai/claude-agent-sdk` with a Zod schema. The handler logic stays. Estimated ~10-15 lines changed per tool. 24 tools × ~15 lines = ~360 lines of mechanical refactor.
- `package.json` — add `@anthropic-ai/claude-agent-sdk` + `zod` + `node-cron` to dependencies.
- `CLAUDE.md` — update the architecture section to describe the new orchestrator + 3 sub-agent topology and Claude Agent SDK adoption.
- `README.md` — same as CLAUDE.md but for human readers.
- `AGENT.md` — rewrite the persona section to point at the master prompt + 4 specialization prompts. Explain the inheritance pattern.
- `tests/tools/*.test.ts` — refactor each to call the new wrapped tool via the Agent SDK's tool-invocation path (or test the underlying handler function directly if exported separately). Logic of the assertions stays; the harness around them changes.

### Files to DELETE

- `src/agent/intent-classifier.ts` — replaced by Agent SDK's description-based routing.
- `src/agent/tool-executor.ts` — replaced by Agent SDK's built-in tool execution.
- `src/agent/tool-registry.ts` — replaced by the `agents:` config in `agents.config.ts`.
- `src/agent/context-window.ts` — replaced by Agent SDK's automatic conversation compaction.
- `src/agent/personality.ts` — its content decomposes into the 5 prompt files (`master.md` + 4 specializations). Keep a thin re-export shim only if other files import it; otherwise delete after the prompt files are populated.

## Tool redistribution (24 existing tools → 3 sub-agents + orchestrator)

Final mapping:

| Tool | Agent | Reason |
|---|---|---|
| `lookup_student` | find-people | Identity lookup is the prerequisite for any matching action. |
| `update_profile` | find-people | Profile updates feed the matching algorithm. |
| `suggest_connection` | find-people | The current squad-mode primitive. |
| `squad_find` (NEW in Slice D) | find-people | Interest-based matching tool. |
| `search_events` | whats-happening | Event discovery is the core of this agent. |
| `submit_event` | whats-happening | Event creation flows through this agent. |
| `get_event_details` | whats-happening | Event detail lookup. |
| `places` (with DPS overlay from Slice A) | whats-happening | Place recommendations including safety. |
| `event_brief_generator` (NEW) | whats-happening | The proactive cron tool. |
| `campus_knowledge` | know-things | Generic USC knowledge retrieval. |
| `freshman_faq` | know-things | Curated FAQ. |
| `describe_course` | know-things | Course catalogue. |
| `recommend_courses` | know-things | Course recommendations. |
| `get_rmp_ratings` | know-things | RateMyProfessor data. |
| `search_courses` | know-things | Course search. |
| `search_programs` | know-things | Major / minor / program search. |
| `plan_schedule` | know-things | Schedule planning. |
| `get_student_academic_state` | know-things | Academic state for advising. |
| `course_tips` | know-things | Section-level course tips. |
| `get_course_reviews` | know-things | Course reviews. |
| `search_roommates` | know-things | Housing search (housing = knowledge domain, not "people connection"). |
| `search_sublets` | know-things | Same. |
| `post_sublet` | know-things | Sublet creation. |
| `set_reminder` | orchestrator-direct | Cross-cutting utility; orchestrator owns it. |
| `load_skill` | orchestrator-direct | Cross-cutting utility for runtime skill loading. |
| `search_helpers` | (internal lib, not a tool) | Already used by multiple tools; stays in `src/lib/search-helpers.ts`. |

**Disposition counts:** Find People = 4 tools (3 existing + 1 new in Slice D). What's Happening = 5 tools (4 existing + 1 new). Know Things = 13 tools. Orchestrator-direct = 2 tools.

**Decision rule for "roommate finder is people OR housing":** Searching for a roommate is a housing-information query (where do I live, with whom, for what rent). The interest-based matching that defines Find People doesn't apply. Sublet/roommate logic lives in Know Things.

## Prompt structure

### `prompts/master.md` (~200 lines, drawn from current personality.ts)

The shared identity layer. Topics covered:
- Identity: George Tirebiter, BIA's ghost-dog AI, 学长 voice
- Tone: lowercase first letter, conversational, slightly mischievous, code-switches Mandarin/English naturally
- Anti-fabrication: refuse cleanly with "戳到知识盲区了😢" when not sure; never invent course numbers / professor names / dates / prices
- Calendar mood overlay: finals week → grumpier, more terse; orientation week → warm; mid-semester → neutral. Reference the academic calendar in `src/agent/calendar.ts` (extracted from personality.ts).
- Brand identity: cherry blossom mark, BIA editorial palette (cream / cardinal / teal); when referencing brand, defer to BIA.
- Refusal categories: medical → Engemann Health Center 213-740-9355; legal → USC legal advice referral; immigration / visa → OIS at OIS@usc.edu; financial → USC Financial Aid Office.
- Underage cohort awareness: some freshmen are 17; no alcohol promotion, no romantic framing, no 18+ events targeted at this cohort.
- Source citation: when factual, always end with "(source: <name>)" — e.g., "(source: usc catalogue 2026)".
- Code-switching examples: 3-5 verbatim from existing distilled WeChat corpus.

### `prompts/orchestrator.md` (~50 lines)

- "You are the orchestrator. You receive a USC student's message and decide how to respond."
- "Three specialist sub-agents are available as tools: Agent('find-people'), Agent('whats-happening'), Agent('know-things')."
- "Always call exactly one sub-agent unless the message clearly spans two domains (e.g., 'who's at the AEPi party Friday' = whats-happening + find-people)."
- "If the message is small-talk, refusal-category, or off-scope, answer directly without invoking a sub-agent."
- "For proactive sends triggered by the event-brief-cron, you receive a special prompt format starting with 'PROACTIVE BRIEF FOR USER X:'; route to whats-happening."
- "Voice when relaying a sub-agent's reply: pass through unchanged; do not paraphrase. The sub-agent has the master voice already."

### `prompts/find-people.md` (~40 lines)

- "You specialize in helping USC students find people for activities, study groups, friendships."
- "Tone when proposing a match: 'hey i think you'd hit it off with [name] for [activity]' — warm, interest-based, NOT romantic."
- "Use squad_find to query by interest tags, suggest_connection to surface candidates from the existing student-connections graph, lookup_student to verify identity."
- "Squad mode rules: only interest-based. NO romantic matching. NO swiping pattern. NO 'match' badges. The product is squad, not a dating app."
- "When you don't have enough info to make a real match: ask one specific question; don't make 5 lukewarm suggestions."

### `prompts/whats-happening.md` (~50 lines)

- "You specialize in events + places + weekend ideas + proactive Event Brief."
- "Reactive mode: respond to questions like 'what's on this weekend' or 'where's a good study spot.'"
- "Proactive mode (triggered when prompt starts with 'PROACTIVE BRIEF FOR USER X:'): generate a 3-5 event ranked brief using event_brief_generator. Open with a calendar-aware mood-appropriate line ('happy wednesday, here's what's up this week' for orientation week; 'hey, quick brief' for finals)."
- "Place safety: when recommending a place, always invoke places (which includes DPS overlay from Slice A). End the recommendation with a safety note if any zone risk applies."
- "Submit-event flow: when a club president submits a new event, validate fields, queue for marketplace approval in bia-admin (Slice C), confirm to the submitter."

### `prompts/know-things.md` (~50 lines)

- "You specialize in USC-specific knowledge: courses, professors, programs, housing, dorm life, immigration, campus services."
- "Anti-fabrication rules apply maximally here. If retrieval doesn't surface an answer with confidence, refuse with '戳到知识盲区了😢' + suggest the user ask Bobby directly or check the source."
- "Always cite the source for factual claims."
- "Course recommendations: default to RMP ratings ≥ 5.0; if none clear 5.0, surface the highest available ≥ 4.0 with explicit caveat."
- "Housing tools (search_roommates, search_sublets, post_sublet) live here despite the 'connection' framing — they are housing-information queries, not interest-matching."

## Data flow

Three representative paths. Each is end-to-end through the new system.

### Path 1: Reactive squad request

```
Student DMs: "hey i wanna find people to go hiking this saturday"
  │
  ▼
src/index.ts /imessage/incoming handler receives, calls runOrchestrator(userId, 'imessage', text)
  │
  ▼
orchestrator.ts builds query({ prompt: text, systemPrompt: master + orchestrator, agents: ... , sessionStore })
  │
  ▼
Claude (orchestrator) reasons: "this is a squad request → call find-people agent"
  │
  ▼
Agent SDK invokes Agent("find-people", "find people who like hiking, free Saturday")
  │
  ▼
find-people sub-agent (master + find-people prompt) calls squad_find(interest='hiking', when='2026-06-08')
  │
  ▼
squad_find tool queries Supabase squad_posts + squad_members (existing tables) for matches
  │
  ▼
Returns 3 candidates with handles + brief intro lines
  │
  ▼
find-people composes: "hey, 3 people are around saturday with hiking interest. [list with intro lines]. want me to introduce you to any of them?"
  │
  ▼
Returns to orchestrator as Agent tool result
  │
  ▼
Orchestrator returns reply unchanged to caller
  │
  ▼
src/index.ts streams reply back over iMessage / web chat
  │
  ▼
sessionStore.save(userId, messages) writes the conversation turn to Supabase
```

### Path 2: Multi-domain question

```
Student DMs: "who's going to the AEPI hotpot party friday"
  │
  ▼ (same plumbing through index.ts → orchestrator)
  │
Claude (orchestrator) reasons: "this is event-and-people. Call whats-happening first to confirm the event, then find-people to look up attendees."
  │
  ▼
Agent("whats-happening", "AEPI hotpot Friday details") → search_events returns event {id, date, location, RSVPs}
  │
  ▼
Agent("find-people", "people attending event-id=X") → squad_find / suggest_connection cross-references
  │
  ▼
Orchestrator composes: "hotpot at AEPI house, friday 7pm, kerckhoff drive. 12 people rsvp'd including [3 names from your network]. want intros?"
  │
  ▼ (back through plumbing)
```

### Path 3: Proactive Event Brief (Wednesday morning)

```
event-brief-cron.ts wakes at 08:00 LA Wednesday
  │
  ▼
Queries user_brief_preferences WHERE cadence='weekly_wed' AND paused=false AND (last_sent_at IS NULL OR last_sent_at < now() - interval '6 days')
  │
  ▼
For each user, calls runOrchestrator(userId, 'cron', 'PROACTIVE BRIEF FOR USER ' + userId + ': generate event brief for the next 7 days')
  │
  ▼
Orchestrator routes to whats-happening (the prompt prefix is the trigger)
  │
  ▼
whats-happening calls event_brief_generator(userId, days=7)
  │
  ▼
event_brief_generator queries: user interest tags + recent activity + upcoming events (instagram scraper + submit-event + USC calendar) + ranks by relevance to user
  │
  ▼
Returns 3-5 ranked events with one-line each
  │
  ▼
whats-happening composes brief: "happy wednesday, here's what's up this week:\n1. ...\n2. ...\n3. ...\nany of these grab you? lmk and i'll save the date."
  │
  ▼
orchestrator passes through; cron sends via iMessage adapter
  │
  ▼
Updates user_brief_preferences.last_sent_at = now()
```

## Memory + sessionStore

The Agent SDK's `sessionStore` interface (per Anthropic docs) has these methods that need implementing:

```typescript
interface SessionStore {
  load(sessionId: string): Promise<Session | null>;
  save(sessionId: string, session: Session): Promise<void>;
  list(): Promise<string[]>;
  delete(sessionId: string): Promise<void>;
}
```

The implementation in `src/agent/session-store.ts`:

- `load(userId)` reads from `messages` (recent N for context window) + `student_memories` (long-term facts about this user: year, major, interests, language preference). Composes a Session object with system context + recent turn history.
- `save(userId, session)` writes the last turn to `messages` + extracts any new facts into `student_memories` (a separate enrichment step; the current code already does this in `src/db/student-memories.ts`).
- `list()` returns recent userIds (used for admin tools, not production runtime).
- `delete(userId)` clears both `messages` and `student_memories` for that user (the `/delete me` command from the design doc's Data Handling section).

Important: the session abstraction lives at the user level (one session per student). Cross-session memory (george remembers you between conversations) is handled by `student_memories`, not by Agent SDK's in-flight session. This matches the design doc's relational moat thesis.

## Event Brief feature (deep spec)

### Database

`supabase/migrations/009_user_brief_preferences.sql`:

```sql
CREATE TABLE public.user_brief_preferences (
  user_id text PRIMARY KEY REFERENCES public.students(user_id) ON DELETE CASCADE,
  cadence text NOT NULL CHECK (cadence IN ('off', 'daily', 'weekly_wed')),
  categories text[] NOT NULL DEFAULT ARRAY['general'],
  paused boolean NOT NULL DEFAULT false,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_brief_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own brief prefs" ON public.user_brief_preferences
  FOR ALL TO authenticated USING (auth.uid()::text = user_id);
```

### Cron job

`src/jobs/event-brief-cron.ts`:

- Uses `node-cron` to schedule two jobs:
  - Daily 08:00 LA: select users with `cadence='daily'`
  - Wednesday 08:00 LA: select users with `cadence='weekly_wed'`
- For each user: skip if `paused`, skip if `last_sent_at` is too recent (24h for daily, 6 days for weekly), else generate + send.
- Generation: builds the prompt `PROACTIVE BRIEF FOR USER {userId}: generate event brief for the next 7 days. User interests: {tags}. Categories: {categories}.`
- Sends via existing iMessage adapter (`enqueueOutgoing` from `src/db/imessage-outgoing.ts`).
- Updates `last_sent_at` on success.

### User cadence preferences UI

Lives in `bia-roommate` (Next.js):

- `bia-roommate/app/account/brief/page.tsx` — preference form: cadence radio (off / daily / weekly Wed), categories checklist (food, music, study, social, career, hackathon, etc.), pause toggle.
- `bia-roommate/app/account/brief/api/route.ts` — POST handler writes to `user_brief_preferences`.

### Tool

`src/tools/event-brief-generator.ts`:

```typescript
export const eventBriefGenerator = tool(
  'event_brief_generator',
  'Generate a ranked 3-5 event brief for a user. Used by the proactive Event Brief cron.',
  {
    userId: z.string(),
    days: z.number().min(1).max(14).default(7),
    interestTags: z.array(z.string()),
    categories: z.array(z.string()),
  },
  async ({ userId, days, interestTags, categories }) => {
    // 1. Query upcoming events from `events` table where event_date BETWEEN now() AND now() + days
    // 2. Filter by categories
    // 3. Score each event by interest-tag overlap with user
    // 4. Take top 5
    // 5. Return as { content: [{ type: 'text', text: serializedEvents }] }
  }
);
```

## Migration plan (this becomes Slice α; happens BEFORE Slice 0.5)

Ordered task list. Each task is a separate PR.

1. **Add Claude Agent SDK + Zod + node-cron deps.** `npm install @anthropic-ai/claude-agent-sdk zod node-cron`. Update `package.json`. Commit.
2. **Decompose personality.ts into prompt files.** Extract the shared parts into `prompts/master.md`. Extract sub-agent specializations into the 4 specialization files. Keep `personality.ts` as a thin shim that re-exports the assembled prompts for any callers that import it. Commit.
3. **Implement sessionStore against Supabase.** Build `src/agent/session-store.ts`. Add tests in `tests/agent/session-store.test.ts`. Verify it round-trips a sample session. Commit.
4. **Rewrap 5 most-used tools as Agent SDK tools.** Pick the 5 highest-volume tools by intent-classifier logs (`campus_knowledge`, `describe_course`, `search_events`, `places`, `lookup_student`). Convert each to `tool()` + Zod. Update their tests to call the wrapped tool via `query()` against a single-tool agent for verification. Commit per tool.
5. **Build orchestrator.ts.** Write the agents config + query() invocation. Initially routes through Agent SDK but only the 5 rewrapped tools are reachable. The 19 remaining tools are still callable via the old path (kept side-by-side during migration). Commit.
6. **Rewrap remaining 19 tools.** Same pattern. Commit per tool or in small batches.
7. **Switch /chat and /imessage/incoming to runOrchestrator().** Remove the old processMessage() call site. Commit.
8. **Delete intent-classifier.ts, tool-executor.ts, tool-registry.ts, context-window.ts, personality.ts shim.** Verify the test suite passes without them. Commit.
9. **Add Event Brief table migration + cron + UI.** Includes the `user_brief_preferences` migration, the cron job in `src/jobs/event-brief-cron.ts`, the `event_brief_generator` tool, the bia-roommate UI for cadence prefs. Commit per artifact.
10. **Run the full orchestrator integration tests.** Verify all 3 paths from the Data Flow section work. Verify the cron triggers + sends on a test fixture. Commit any test fixes.
11. **Update CLAUDE.md / README.md / AGENT.md.** Document the new architecture, the migration, the master-prompt-inheritance pattern. Commit.
12. **Tag the cutover.** `git tag v2.0.0-agent-sdk` so we can revert atomically if needed.

Estimated total: 1.5–2 weeks for one focused engineer. The pattern enables parallelizing tool rewraps across multiple engineers if available.

## Testing strategy

- **Tool tests (24 → 24 in `tests/tools/`):** rewritten to invoke through `query()` with a stub master prompt + single-tool agent. The handler logic is exercised the same way; only the harness changes.
- **Agent tests (NEW in `tests/agent/orchestrator.test.ts`):** spec'd in Components section. Cover routing across all 3 paths from Data Flow.
- **Cron tests (NEW in `tests/jobs/event-brief-cron.test.ts`):** spec'd in Components section.
- **Round-trip tests (existing `tests/round-trip/`):** stay as is. They test the HTTP boundary, which is unchanged.
- **Eval suite (NEW in `tests/eval/`):** the same golden set planned for Slice F. After this migration, the golden set runs against the new orchestrator end-to-end.
- **Persona consistency test:** new test in `tests/agent/persona.test.ts` that runs the 4 agents against a shared "describe yourself" prompt and asserts the master prompt's voice rules (lowercase, no fabrication, code-switch) appear in all 4 responses. Catches drift between specializations.

## Error handling and failure modes

| Failure | Where | What the user sees | Mitigation |
|---|---|---|---|
| Claude rate-limited mid-stream | Orchestrator query() | Friendly fallback message ("一秒, getting hit with traffic — try again") | Caught in `runOrchestrator`, returns generic retry message via `RELAY_FALLBACK_MSG`. |
| Sub-agent crashes (e.g., tool error inside) | Sub-agent execution | Orchestrator sees the Agent tool result with `isError: true`; decides to retry, route to another sub-agent, or compose its own apology. | Each tool returns `{ content: [...], isError: true }` on failure. Orchestrator prompt teaches retry/route logic. |
| sessionStore fails to load | runOrchestrator | george acts like a brand-new conversation (no memory). User sees "uhh, doesn't ring a bell, refresh me?" | sessionStore.load wraps Supabase calls in try/catch; on failure returns empty session + logs to observability. |
| Event Brief cron timing-out per user | event-brief-cron.ts | Brief not sent that cycle; next cron pick it up. | Per-user `Promise.allSettled`, 60s timeout each, missed users retried at next scheduled run. |
| Brief sends spam (multiple sends per day) | last_sent_at race | User gets duplicate brief in iMessage. | `last_sent_at` updated in a single UPDATE statement before send; if send fails, mark as not-sent so the retry isn't a duplicate. |
| Master prompt + sub-agent prompt collide / contradict | All agents | Voice drifts; persona regression. | Persona consistency test (Testing section). Reviewed manually whenever master.md changes. |
| Tool returns malformed Zod-shape data | Sub-agent | Agent SDK catches the schema mismatch, surfaces a tool-error to the agent. | Existing tests + the Zod schema definition both enforce shape. |
| Sub-agent calls a tool not in its `tools:` config | Sub-agent | Agent SDK refuses; sub-agent gets an "unavailable tool" error and adapts. | The `tools:` config in `agents.config.ts` is the source of truth for tool access; no runtime escape. |

## NOT in scope

- Sub-agents calling their own sub-agents (Agent SDK doesn't support nested delegation; not needed for george's 1-level pattern).
- Migrating the iMessage Photon SDK or Mac mini bridge architecture (Slice α only touches the agent core; the iMessage layer is unchanged).
- Cross-school expansion (UCLA, NYU, Columbia) — out of scope per design doc.
- Spatial reasoning layer (Slice A in the roadmap) — depends on the new architecture but built separately.
- Squad mode matching tool (Slice D) — same.
- Marketplace approval UI (Slice C) — same.
- Web fallback chat UX in bia-roommate (Slice E) — same.
- Voice notes / multimodal responses.
- The brand name remains "george" (English only; the bilingual middle-dot pattern is reserved for features, not the product name).

## Open questions for the user

These are non-blocking but worth resolving before implementation begins:

1. **Should `search_helpers` (currently an internal lib) be promoted to a tool exposed to know-things?** Pro: makes the search-helper logic explicit. Con: it's a utility; not user-facing. Default: keep as `src/lib/search-helpers.ts`.
2. **Should the orchestrator have its own LLM model (opus) different from sub-agents (sonnet)?** Orchestrator routing is cheap-to-compute; sub-agents do the heavy lifting. Default: opus for orchestrator, sonnet for find-people + whats-happening, opus for know-things (knowledge accuracy matters).
3. **Cadence preferences default for a new user?** Options: off (opt-in), weekly Wed (opt-out), or ask during onboarding (Slice B). Default proposed: ask during onboarding (Slice B integration point).
4. **What's the source of truth for "USC Wednesday 08:00 LA"?** Use `America/Los_Angeles` timezone; node-cron supports tz natively.
5. **Where do the prompt files (`prompts/*.md`) get committed?** Inside the george repo at `prompts/` (relative to repo root). Tracked in git so changes are visible and reviewable.

## Acceptance criteria

The redesign is complete when:

- All 24 existing tools are reachable via the new orchestrator (verified by `tests/agent/orchestrator.test.ts`).
- The 4 prompt files exist and the master prompt's voice rules are enforced in all 4 sub-agents (verified by `tests/agent/persona.test.ts`).
- The session store correctly round-trips a conversation (verified by `tests/agent/session-store.test.ts`).
- The Event Brief cron sends a brief for at least one test user on a daily and a weekly Wed cadence (verified by `tests/jobs/event-brief-cron.test.ts`).
- The `intent-classifier.ts`, `tool-executor.ts`, `tool-registry.ts`, `context-window.ts` files are gone from the repo.
- `package.json` includes `@anthropic-ai/claude-agent-sdk`, `zod`, `node-cron`.
- CLAUDE.md + README.md + AGENT.md reflect the new architecture.
- All 33 existing tests pass (after the test-harness rewrites).
- The deployed `/chat` endpoint produces a response equivalent in quality to the pre-migration version for a smoke-test golden set of 20 queries.

## Cross-references

- Office-hours design doc: `~/.gstack/projects/george/mac-design-george-v2-20260607-175231.md`
- Reality-aware roadmap (downstream slices): `docs/superpowers/plans/2026-06-07-roadmap-v2-reality-aware.md`
- Migrations reconcile plan (Slice 0.5, runs AFTER this): `docs/superpowers/plans/2026-06-07-slice-0.5-migrations-reconcile.md`
- Approved mockups (relevant for any UI work in Slice α): `~/.gstack/projects/george/designs/F1-F5-approved-mockups-20260607.png`
