# george V2 Roadmap (Reality-Aware, 2026-06-07)

> **This supersedes the slice numbering in the office-hours design doc.** The design doc was written without seeing the actual codebase. After auditing what exists at `BIBOYANG425/george`, much of the "8-week build" is already shipped. This roadmap is a focused 5-week plan covering ONLY what's genuinely missing.

**Source of truth design doc:** `~/.gstack/projects/george/mac-design-george-v2-20260607-175231.md`

**Roadmap status:** APPROVED — bobby chose option A (rewrite to match reality) during `/plan-eng-review` 2026-06-07.

---

## Reality audit (what's already shipped)

These slices from the design doc are already done. No re-implementation work.

| Design Doc Reference | Reality | Evidence |
|---|---|---|
| iMessage gateway choice (Mac-tethered relay) | Dual-mode shipped 10 days ago. Path A = Mac mini in China + Cloudflare Container backend; Path B = iPhone Shortcuts polling fallback. SDK is `@photon-ai/imessage-kit`, NOT BlueBubbles/pypush. | PR #1 merged. `src/adapters/imessage.ts`, `src/index.ts` `/imessage/*` endpoints, `src/db/imessage-outgoing.ts`. CLAUDE.md has the full ASCII deployment topology. |
| Persona (lowercase, 学长 voice, anti-fabrication) | Built and 46 KB of personality logic. Calendar-aware moods (finals → grumpy, orientation → warm), section-level course tips, anti-fab tests. | `src/agent/personality.ts`, `src/agent/bia-lore.ts`, `tests/agent/`, `tests/tools/personality.test.ts`. |
| Multi-agent architecture (5 sub-agents) | Built. Intent classifier routes each message. Event / course / housing / social / campus sub-agents. | `src/agent/intent-classifier.ts`, `src/skills/`, `tests/skills/`. |
| 462-message corpus mining | Built. WeChat ingestion script exists. | `scripts/ingest-wechat.ts` (18 KB). |
| Course agent + RMP integration + anti-fab | Built. Recent PR #51 / #52 polished it (writ150 tier softening, RMP fallback rules). | `src/tools/recommend-courses.ts`, `src/tools/describe-course.ts`, `src/tools/get-rmp-ratings.ts`, `tests/tools/`. |
| Instagram event scraping | Built with weekly Mon 12:00 PT cron. Apify-backed. | `src/scrapers/`, `src/jobs/`, recent commits 2c62bbb / a1a0baf / 1268372. |
| Web chat backend (`/chat` API) | Built. Auth via `ADMIN_TOKEN`. Relayed by bia-roommate. | `src/index.ts`, README + CLAUDE.md `/chat` contract. |
| Security hardening | Built. CORS locked, `/stats` gated, generic error responses, prompt-injection check at `/imessage/incoming` boundary. | PR commit `e2720da`. `src/security/`. |
| Test infrastructure | Built. 33 test files across adapters/agent/injection/memory/proactive/round-trip/scrapers/security/services/skills/tools. Vitest. | `tests/`, `vitest.config.ts`. |

If any of these need extension (e.g., new sub-agent, new tool), that's a separate small PR, not roadmap-scope work.

---

## What's actually missing (the 5-week roadmap)

Five new slices, A-E. Slice 0.5 stays as the blocker.

### Slice 0.5: Migrations reconcile + RLS audit (Week 1)
**Status:** Plan written at `docs/superpowers/plans/2026-06-07-slice-0.5-migrations-reconcile.md`. 10 tasks + RLS audit checklist. Execute first; nothing else can ship cleanly until source-of-truth is restored across `george` and `bia-admin`.

**Blocking:** YES. All other slices can begin after Slice 0.5 PRs merge.

### Slice A: Spatial reasoning layer (Week 2-3)
**Goal:** Add safety-aware location recommendations. The existing `src/tools/places.ts` queries Google Places but does not apply DPS-zone filtering, distance comparisons, or transit awareness.

**New code:**
- `src/services/spatial.ts` — distance calculation, DPS-zone polygon containment, walking-time estimates.
- `src/tools/safe-route.ts` — "is this place safe to walk to at 11 PM?" tool.
- `src/tools/distance-compare.ts` — "which of these is closest?" tool.
- `src/tools/dps-zone-check.ts` — explicit zone lookup tool.
- Extend `src/tools/places.ts` to call the spatial service for safety filtering on results.

**New migrations (in `BIBOYANG425/george/supabase/migrations/`):**
- `005_spatial_locations.sql` — `spatial_locations` table with PostGIS `geometry(POINT, 4326)` column and GIST index.
- `006_dps_zones.sql` — `dps_zones` table with `geometry(POLYGON, 4326)`, name, risk level.
- `007_transit_stops.sql` — Metro/USC tram stops with coordinates.
- Enable PostGIS extension: `CREATE EXTENSION IF NOT EXISTS postgis;` (Supabase supports this out of the box).

**Data ingestion:**
- One-time script `scripts/ingest-spatial.ts` to bulk-load USC buildings + dorms + Metro stops from OpenStreetMap (Overpass API).
- DPS zone polygons hand-compiled (~20 zones, half-day work) from DPS.usc.edu safety map. Stored as a versioned `data/dps-zones-v1.geojson` checked into the repo.

**Tests:**
- `tests/services/spatial.test.ts` — distance math correctness, polygon containment edge cases.
- `tests/tools/safe-route.test.ts` — "Dino's at 11 PM" returns yellow-zone warning, "library" returns green.
- `tests/tools/dps-zone-check.test.ts` — known coordinate inside Zone 2 returns "Zone 2", coordinate outside USC returns "outside DPS coverage".

**Eval requirement:** Add 10 spatial-reasoning questions to the golden set in Slice F. Examples: "is the taco place on Jefferson safe to walk to at 10 PM", "what's closest to UPC dorm A", "what's the safest route from Leavey Library to my dorm at midnight".

**Parallel-safe with:** Slice B (different services).

### Slice B: Custom onboarding flow (Week 2-3, parallel with A)
**Goal:** Build the web → iMessage → profile → USC email verification flow Bobby designed in office-hours.

**New code:**
- `bia-roommate/app/george/onboard/page.tsx` — landing page with "Try george on iMessage" CTA.
- `bia-roommate/app/george/onboard/api/start/route.ts` — POST `/api/george/onboard/start`: generates a 6-character alphanumeric ID (24-hour TTL), returns the pre-filled `imessage://` deep-link URL.
- `bia-roommate/app/george/onboard/[id]/profile/page.tsx` — profile completion page (name, year, major, interests, USC email).
- `bia-roommate/app/george/onboard/[id]/verify/page.tsx` — USC email verification code entry.
- `george/src/index.ts` — handle "I am ready to try george with ID-ABC123" message format in the existing `/imessage/incoming` or `/chat` flow. New helper `parsePendingOnboardingId(text)`. Match phone number + ID + (after profile) USC email, then trigger george greeting + contact card link.
- `george/src/services/onboarding.ts` — pending-signup state machine.

**New migration (in `BIBOYANG425/george/supabase/migrations/`):**
- `008_pending_onboarding.sql` — `pending_onboarding` (id PRIMARY KEY, phone, profile_id, usc_email, verified_at, created_at, expires_at). GC by `expires_at < now()` in the existing cron job.

**Email service:** Resend.com is the standard. Add `RESEND_API_KEY` to `.env.example` with `[agent]` tag. Email template lives in `src/services/email-templates/verify.tsx` (React Email).

**Tests:**
- `tests/services/onboarding.test.ts` — ID generation uniqueness, expiry math, match logic.
- `tests/round-trip/onboarding.test.ts` — full E2E: web click → simulate iMessage receive → simulate web profile submit → simulate email verify → confirm `students` row created and `pending_onboarding` cleaned up.

**Cron job extension:** `src/jobs/cleanup.ts` (new) runs every 6 hours, deletes expired pending_onboarding rows + sends 6-hour nudge to users who haven't completed.

**Parallel-safe with:** Slice A.

### Slice C: Marketplace approval queue + cap enforcement (Week 3-4)
**Goal:** Build the admin UI for moderating club event submissions, enforce the 20-events/week marketplace cap and 30-matches/week squad cap from the design doc's D-with-caps decision.

**New code (in `bia-admin`):**
- `bia-admin/app/admin/marketplace/page.tsx` — queue view, list pending events, approve/reject buttons.
- `bia-admin/app/admin/marketplace/api/decisions/route.ts` — POST decision, write to `event_approval_queue` + `admin_audit_log`.
- `bia-admin/lib/marketplace/cap-enforcement.ts` — check weekly event count, prevent submissions over cap, surface "queue full" UI state.

**Existing code to reuse:**
- `george/src/tools/submit-event.ts` already handles event ingestion. Extend to enqueue to `event_approval_queue` instead of writing directly to `events`.
- `bia-admin` already has `admin_audit_log` pattern + `admin_users` permission model. Reuse for 2-ops-people approval (Bobby + designated backup).

**New migration (in `bia-admin/supabase/migrations/`):**
- `YYYYMMDD_event_approval_queue.sql` — `event_approval_queue` (id, event_id FK, submitting_club_id, submitted_at, status enum, decided_by, decided_at, reject_reason).

**Cap enforcement logic:**
- Marketplace: count `events` where `approved_at` >= now() - 7 days, if >= 20, return 429 with body "queue full this week".
- Squad: count `squad_matches` where `created_at` >= now() - 7 days, if >= 30, defer to next week.

**Tests:**
- `bia-admin/tests/lib/marketplace/cap-enforcement.test.ts` — boundary cases (19, 20, 21 events in window).
- `bia-admin/tests/app/admin/marketplace/decisions.test.ts` — happy path approve, happy path reject with reason, unauthorized user blocked, audit log written.

**Acceptance criteria for shipping:** Bobby + backup ops person can both log in, approve test events, see audit trail. Cap enforces correctly at boundary.

**Parallel-safe with:** Slice D.

### Slice D: Squad mode matching (Week 3-4, parallel with C)
**Goal:** Ship the interest-tag matching feature so Series's "warm intro" wedge has a george-side counter. Existing `src/tools/suggest-connection.ts` is the foundation.

**New code (in `BIBOYANG425/george`):**
- `src/services/squad-matcher.ts` — interest-tag overlap algorithm, with simple weighted scoring (shared interests = 1.0, shared major = 0.5, shared year = 0.3).
- `src/tools/squad-post.ts` — let students post "looking for [activity]" requests.
- `src/tools/squad-find.ts` — find matches for a given post.
- `bia-admin/app/admin/squad/page.tsx` — manual matching dashboard for the concierge-phase ops. Shows pending posts, suggests matches, lets ops approve a match (which triggers george to DM the intro).

**Reuse:**
- `src/tools/suggest-connection.ts` and `src/tools/post-sublet.ts` patterns.
- Existing tables `squad_posts`, `squad_members`, `student_connections`.

**Cap enforcement:** Tied to Slice C cap-enforcement.ts.

**Tests:**
- `tests/services/squad-matcher.test.ts` — known-input scoring correctness, edge case (no matching interests returns empty), respects cap.
- `tests/tools/squad-post.test.ts`, `tests/tools/squad-find.test.ts`.

**Persona constraint (already in personality.ts but worth flagging):** Squad mode is interest-based, NOT romantic. george's voice when posting matches should reflect "hey i think you'd hit it off with [name] for [activity]" — NOT "you matched with [name]". The personality.ts file has this constraint; tests should enforce it stays.

**Parallel-safe with:** Slice C.

### Slice E: Web fallback chat UI (Week 4-5)
**Goal:** Ship the `george.uscbia.com` full-page chat per the F4 mockup approved during `/plan-design-review`.

**New code (in `bia-roommate`):**
- `bia-roommate/app/george/chat/page.tsx` — full-page chat, matches F4 mockup (cream background, Instrument Serif italic header, cardinal student bubbles, cream george bubbles with cherry blossom avatar).
- `bia-roommate/app/george/chat/components/MessageBubble.tsx`, `CherryBlossomAvatar.tsx`, `IMessageBanner.tsx`.
- Backend already exists: bia-roommate's existing `/api/george/chat` relay to george's `/chat` endpoint.

**Brand inheritance (already documented in design doc):**
- Background: `#F2EBD9` cream.
- Display: Instrument Serif italic for headlines.
- Body: ZCOOL XiaoWei for Chinese characters in content.
- Accent: deep cardinal `#71031F` for student bubbles + send button.
- Avatar: hand-illustrated cherry blossom SVG (commission once, reuse across all surfaces).
- Footer: small "powered by BIA" credit.

**Implementation override (from `/plan-design-review`):** Header reads "george" (English only), NOT "george · 阁治" despite what the F4 mockup shows.

**Tests:**
- `bia-roommate/tests/app/george/chat.test.tsx` — renders happy path, sends message → receives response, error state when backend 500s.
- E2E via Playwright: load page → type message → assert response within 5 seconds.

**Parallel-safe with:** Slice F.

### Slice F: Golden set + retrieval eval (Week 4-5, parallel with E)
**Goal:** Verify the existing retrieval (Slice 3 in design doc) actually works. Build the 100-question golden set, run it against current `campus-knowledge.ts` + `freshman-faq.ts` tools, identify gaps.

**New code (in `BIBOYANG425/george`):**
- `scripts/build-golden-set.ts` — combine: top 20 patterns from 462-message corpus (use existing `ingest-wechat.ts` output) + 30 questions from June 14 freshman outreach + 30 spatial-reasoning questions from Slice A + 20 edge cases (IYA, OIS, immigration, financial aid).
- `tests/eval/retrieval-quality.test.ts` — vitest test that runs the golden set through `campus-knowledge.ts` and asserts >= 95% correct (rubric: correct / partially correct / wrong / refused). Marks any "wrong" with the specific tool that returned it.
- `tests/eval/__fixtures__/golden-set.json` — the question + expected-answer-rubric data.
- `npm run test:eval` script added to `package.json`.

**Eval rubric:**
- correct: factually accurate + sourced.
- partial: factually accurate but missing source attribution OR misses a useful follow-up.
- wrong: factually inaccurate OR fabricates a fact not in the knowledge base.
- refused: returns "戳到知识盲区了😢" when the question is in scope (false-negative refusal).

**Ship gate:** correct + partial >= 95%, wrong + bad-refused <= 5%.

**Parallel-safe with:** Slice E.

---

## Dependency diagram

```
                    Slice 0.5: Migrations Reconcile
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
            Slice A         Slice B       Slice C       Slice D
           (Spatial)      (Onboarding)  (Marketplace)  (Squad)
                │             │             │            │
                └──────┬──────┘             └─────┬──────┘
                       ▼                          ▼
                   Slice F                    (depends on C
                   (Eval)                      cap-enforcement)
                       │                          │
                       └─────────┬────────────────┘
                                 ▼
                             Slice E
                          (Web fallback)
```

Critical path (longest): Slice 0.5 → A → F → E = 5 weeks.

Parallelization opportunity: Slices A, B, C, D can ALL run in parallel after 0.5 if Bobby + backup + 1-2 collaborators are available. With a 3-person team, the critical path drops to 3-4 weeks.

---

## NOT in scope (deferred or explicitly out)

- **Slice 2 (preview video production):** Not code. Run in parallel as a Bobby + designer task with the existing brand assets.
- **Slice 7 (partner-club outreach):** Operational; not code.
- **Cross-school expansion (UCLA, NYU, Columbia):** Deferred to Spring 2027 per design doc.
- **Apple Messages for Business migration:** Photon SDK is shipped and works. Defer Apple MfB outreach until scale demands it.
- **iMessage approval risk mitigation beyond what's already in place:** Path B fallback exists. No new work.
- **Voice notes / multimodal responses:** Deferred until text RAG is rock solid.
- **Bilingual product name ("george · 阁治"):** Resolved during `/plan-design-review` — product ships as "george" English only.
- **Series competitor analysis:** Documented in design doc's Outside Voice Concerns. Operational follow-up, not code.
- **Mac single-point-of-failure mitigation (failover Mac):** Documented as risk in Outside Voice Concerns. Path B + Container backend already provide resilience. Defer dedicated failover until production volume justifies.
- **DPS-zone ongoing update process:** Hand-compile once now (Slice A). Quarterly refresh becomes a calendar reminder, not infra.

---

## Test coverage strategy

Current state: 33 test files. After this roadmap: ~50+ test files added (Slices A/B/C/D/E/F each add 3-8 tests).

Test pyramid:
- Unit (vitest): pure functions (distance math, scoring, parsers, prompt-injection check). Most of the new code.
- Integration: cross-module behavior (onboarding state machine, marketplace approval + audit log + email send).
- E2E (round-trip): the existing `tests/round-trip/` directory pattern. One per user-facing feature: onboarding end-to-end, marketplace submit-approve-surface, squad post-match-DM, web fallback chat happy path.
- Eval (`tests/eval/`): retrieval quality, persona tone, safety-refusal correctness. Run as `npm run test:eval`.

CI from Slice 0.5's task 9 stays in place. Add `npm run test:eval` as a separate CI step gated by `RUN_EVALS=true` (the eval suite uses LLM calls and costs ~$0.50/run; gate to main-branch + release tags only).

---

## Failure modes (one per slice)

| Slice | Failure mode | Mitigation in plan |
|---|---|---|
| 0.5 | Drift CI false-positive blocks PRs | Audit script outputs include line-by-line reason; engineer can add `// SKIP-RECONCILE: <reason>` comment to silence one specific table if needed. |
| A | DPS polygon containment misclassifies edge cases | Hand-test 5 known coordinates against each zone before shipping. Failing test = block ship. |
| B | iMessage URL format breaks on Android (no iMessage) | Web detects user-agent + falls back to SMS:// or shows "iMessage only" message. Tested in `tests/round-trip/onboarding.test.ts`. |
| C | Cap calculation race condition (two parallel approvals push count to 21) | Use `SELECT ... FOR UPDATE` row lock in cap-enforcement.ts. Test simulates concurrent requests. |
| D | Squad matching produces awkward / wrong introductions | Existing personality.ts anti-fab tests cover voice. Add specific test: post + match flow returns natural-sounding intro, NOT formulaic "you matched with X". |
| E | Chat page renders broken on slow connection | Skeleton loading states from F4 mockup. Playwright test with throttled network. |
| F | Eval golden set drifts as knowledge base updates | Re-run weekly via the existing Instagram cron, alert if pass rate drops below 90%. |

---

## Implementation Tasks (synthesized)

- [ ] **T1 (P1, human: ~5d / CC: ~1d)** — Slice 0.5 — Execute existing plan
  - Surfaced by: this roadmap
  - Files: `docs/superpowers/plans/2026-06-07-slice-0.5-migrations-reconcile.md`
  - Verify: drift test passes in CI, both PRs merged
- [ ] **T2 (P1, human: ~10d / CC: ~3d)** — Slice A — Spatial reasoning layer
  - Surfaced by: design doc deferred decision F1 (DPS) + this roadmap
  - Files: `src/services/spatial.ts`, `src/tools/{safe-route,distance-compare,dps-zone-check}.ts`, `supabase/migrations/005-007_*.sql`, `data/dps-zones-v1.geojson`, `scripts/ingest-spatial.ts`
  - Verify: `tests/services/spatial.test.ts` + spatial-questions in golden set pass at 95%+
- [ ] **T3 (P1, human: ~8d / CC: ~2d)** — Slice B — Custom onboarding flow
  - Surfaced by: Bobby's office-hours flow design
  - Files: `bia-roommate/app/george/onboard/**`, `src/services/onboarding.ts`, `supabase/migrations/008_pending_onboarding.sql`, `src/services/email-templates/verify.tsx`
  - Verify: `tests/round-trip/onboarding.test.ts` E2E passes
- [ ] **T4 (P1, human: ~6d / CC: ~2d)** — Slice C — Marketplace approval queue + cap enforcement
  - Surfaced by: D-with-caps decision
  - Files: `bia-admin/app/admin/marketplace/**`, `bia-admin/lib/marketplace/cap-enforcement.ts`, `bia-admin/supabase/migrations/YYYYMMDD_event_approval_queue.sql`
  - Verify: cap-boundary tests pass, manual approve flow logged in audit log
- [ ] **T5 (P1, human: ~6d / CC: ~2d)** — Slice D — Squad mode matching
  - Surfaced by: design doc D-with-caps decision
  - Files: `src/services/squad-matcher.ts`, `src/tools/{squad-post,squad-find}.ts`, `bia-admin/app/admin/squad/**`
  - Verify: matching tests pass, persona-tone test ensures natural intros not formulaic
- [ ] **T6 (P1, human: ~4d / CC: ~1d)** — Slice E — Web fallback chat UI
  - Surfaced by: F4 mockup
  - Files: `bia-roommate/app/george/chat/**`
  - Verify: chat page renders, sends message, receives response within 5s (Playwright E2E)
- [ ] **T7 (P1, human: ~3d / CC: ~1d)** — Slice F — Golden set + retrieval eval
  - Surfaced by: 95% retrieval ship gate in design doc
  - Files: `scripts/build-golden-set.ts`, `tests/eval/retrieval-quality.test.ts`, `tests/eval/__fixtures__/golden-set.json`
  - Verify: `npm run test:eval` passes at 95% correct
- [ ] **T8 (P3, human: ~1h / CC: ~10min)** — Update CLAUDE.md and HANDOFF.md
  - Surfaced by: this roadmap
  - Files: `CLAUDE.md`, `HANDOFF.md`
  - Verify: reference this roadmap, link to slice plans as they're written

---

## Roadmap-level handoff

- **Cadence:** One slice plan written per week as we approach it. Each gets its own `docs/superpowers/plans/YYYY-MM-DD-slice-<X>-<name>.md` written via `/superpowers:writing-plans`.
- **Reviews:** Each slice plan should pass `/plan-eng-review` before implementation begins. The slice plans are smaller scope (~10 tasks each) so reviews are fast.
- **Mockups:** Slice E (web fallback) inherits from F4 mockup. Slice A's safe-route output design needs no mockup; UI is iMessage-only. Other slices are mostly backend.
- **Owner:** Bobby + 1-2 collaborators per the design doc's Open Q1. This roadmap assumes ~30 dev hours/week combined. If team is just Bobby, double the calendar duration.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | ISSUES_OPEN | First run had 8 outside-voice concerns documented in design doc. This re-run produced a reality-aware roadmap; existing concerns inherit. |
| Design Review | `/plan-design-review` | UI/UX gaps | 2 | CLEAN | Score 3 → 9. 13 decisions made, F1-F5 mockups approved. F4 implementation override noted. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** 8 Outside Voice Concerns from the first eng review remain valid (Mac SPOF, DPS ongoing update owner, Series win condition, preview-vs-delivery wait gap, corpus bias mitigation timing, team size HARD BLOCKER for Open Q1, onboarding scope sprawl risk, Slice 0.5 timeline estimation). All documented in the design doc + applicable to this roadmap.
- **VERDICT:** Eng Review ISSUES_OPEN (acceptable — the documented concerns are operational risks the founder has accepted, not architectural blockers). Roadmap is implementable as written. Run /ship gating manually against the existing concerns until they're resolved.
