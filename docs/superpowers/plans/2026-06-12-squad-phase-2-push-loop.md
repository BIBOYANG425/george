# Squad Phase 2 — george Push Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** george becomes the 找搭子 organizer: tell him what you want → he drafts → you approve → the post lands on the shared board and the matching engine pings the few opted-in students most likely to join — with consent, caps, and quiet hours enforced, and no ping ever silently dropped.

**Architecture:** Prerequisite first (CEO-D8/eng-E7): george deploys to **Railway** via a fixed multi-stage Dockerfile (`TRANSPORT=spectrum`, `IMESSAGE_ENABLED=false`, stable URL replaces the quick tunnel). Then the loop: the find-people sub-agent is rewritten as a 找搭子 concierge with three new tools (`create_squad_post`, `find_squad_posts`, `join_squad_post`) and a `/pings on|off` consent command; a `ping-engine` service calls `match_users_for_post` (floors + SQL consent), applies cap/quiet-hours/channel suppression, records every outcome in `squad_pings`, and delivers via the strategy a Task-1 spike selects (Spectrum proactive send if the SDK supports it on the shared pool; otherwise the legacy `imessage_outgoing` queue). A token-gated `POST /squad/draft` endpoint powers bia-roommate's form-prefill assist (design G6).

**Tech Stack:** george (Express + Claude Agent SDK + spectrum-ts), Railway (Dockerfile deploy), Supabase RPCs from Phase 0/1, vitest.

**Source spec:** `bia-roommate/docs/superpowers/specs/2026-06-12-squad-reimagined-design.md` §5.2, §8, §10 Phase 2, §11.6 (scripts). Decisions honored: D5 (pure opt-in), E3 (iMessage-only pings, `suppressed_no_channel`), D6/G6 (form leads, george prefills), D8 (cloud prerequisite).

**Repos/branches:** george `feat/squad-push-loop` off main. bia-roommate describe-box rides a small `feat/squad-prefill-assist` branch **after the Phase 1 PR merges** (it touches `/squad/submit`). No new bia-admin migrations (Phase 0/1 schema suffices).

**Ground truth (recon 2026-06-12):** george main = merged Spectrum transport; Dockerfile copies pre-built `dist/` and **omits `prompts/` + `assets/`** (would crash: `agents.config.ts` reads `prompts/*.md` at module load) — must become multi-stage. `/health` exists; `PORT` env respected (Railway injects it). PR #7 notes: "Spectrum proactive-send requires creating a conversation space to an arbitrary handle — out of scope" → spike required. Identity: `students.imessage_id` maps handles; opted-in recipients are george-linked by definition (E3). Heartbeat proactive sends still use `enqueueOutgoing` (legacy queue) — that queue is the designed fallback. User commands live in `src/agent/user-command-router.ts` (side-effect-free) + `src/tools/user-commands.ts`.

---

## Bobby's part (the only human steps — ~15 min, before Task 7)

1. **railway.app** → sign in with GitHub → New Project → Deploy from GitHub repo → `BIBOYANG425/george` (after Task 0's Dockerfile fix merges to the branch, point Railway at branch `feat/squad-push-loop` for the burn-in, switch to `main` after merge).
2. **Variables tab** → paste the env block I'll generate in Task 0 Step 4 (your Mac `.env` values minus Mac-only ones; `TRANSPORT=spectrum`, `IMESSAGE_ENABLED=false`).
3. Copy the generated `*.up.railway.app` URL → tell me; I verify `/health`, then you (or I, via vercel env if you prefer) set `GEORGE_BACKEND_URL` on bia-roommate's Vercel project.
4. **Cutover rule:** the moment Railway's Spectrum connection is green, STOP the Mac instance (two live Spectrum connections on the shared pool = the orphaned-routing flakiness from PR #7 burn-in).

---

### Task 0: Railway-ready build (the D8 prerequisite, code half)

**Files:** Rewrite `Dockerfile`; create `.dockerignore`, `docs/DEPLOY-railway.md`.

- [ ] **Step 1: Multi-stage Dockerfile** (fixes the pre-built-dist assumption AND the missing-prompts crash):

```dockerfile
# Build stage — compile TS inside the image so git-connected deploys work.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Runtime stage — production deps only + every runtime-read asset.
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ ./dist/
# agents.config.ts resolves prompts/ relative to dist/ at module load;
# spatial tools read data/; onboarding sends assets/. All three are runtime deps.
COPY prompts/ ./prompts/
COPY data/ ./data/
COPY assets/ ./assets/
ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch(`http://localhost:${process.env.PORT||3001}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: `.dockerignore`** — `node_modules`, `dist`, `.env*`, `.git`, `docs`, `tests`, `*.log`.

- [ ] **Step 3: Verify locally** — `docker build -t george-test . && docker run --rm -e PORT=3001 --env-file .env -e IMESSAGE_ENABLED=false -e TRANSPORT=legacy george-test` in one shell, `curl localhost:3001/health` in another (TRANSPORT=legacy for the local smoke so it doesn't fight the Mac's Spectrum connection). If Docker isn't available locally, the verify happens on Railway's first build instead — note it.

- [ ] **Step 4: `docs/DEPLOY-railway.md`** — the env checklist for Bobby's paste, names only with required/optional markers: required = `ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN, TRANSPORT=spectrum, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, IMESSAGE_ENABLED=false, BIA_ROOMMATE_API_URL=https://www.uscbia.com, HEARTBEAT_ENABLED, DEEPSEEK_API_KEY (or HEARTBEAT_LLM_PROVIDER fallback), KIMI_API_KEY`; optional = `GOOGLE_MAPS_API_KEY, APIFY_TOKEN, KV_*, ONBOARDING_*, PROACTIVE_*`. Plus the cutover rule and the Vercel `GEORGE_BACKEND_URL` step.

- [ ] **Step 5: Commit** — `git add Dockerfile .dockerignore docs/DEPLOY-railway.md && git commit -m "feat(deploy): railway-ready multi-stage image (builds TS, ships prompts/data/assets)"`

---

### Task 1: SPIKE — Spectrum proactive send (decides ping delivery)

**Files:** Create `docs/superpowers/notes/2026-spectrum-proactive-spike.md`.

- [ ] **Step 1:** Read `node_modules/spectrum-ts` types/exports (and `src/adapters/spectrum-client.ts`): is there ANY API to open/send to a conversation space by handle (e.g. `app.send(to, …)`, `app.spaces.get/create`, exported `Space` constructors) without an inbound message in hand? Check the shared-pool constraints in the vendored docs/types.

- [ ] **Step 2:** If an API exists, write a 10-line probe script (env-gated, sends ONE test message to `GEORGE_TEST_HANDLE` — Bobby's own number) and run it once. If not, skip.

- [ ] **Step 3:** Record the decision in the note:
  - **Strategy A (API exists + probe works):** ping delivery = direct Spectrum send; add `sendProactive(handle, text)` to the spectrum client seam.
  - **Strategy B (otherwise):** ping delivery = `enqueueOutgoing(handle, text)` — the existing legacy `imessage_outgoing` queue the heartbeat already uses (iPhone-Shortcut drains it; ≤60s latency, acceptable for pings). `squad_pings.status='sent'` means *enqueued*; channel field records `imessage_queue`.
  
  Either way the engine's interface is one injected `deliver(handle, text): Promise<void>` — the strategy is a one-line swap. **Do not block on A; B ships Phase 2.**

---

### Task 2: ping-engine service (TDD — invariants #2 and #3 live here)

**Files:** Create `src/services/squad-ping-engine.ts`; Test `tests/services/squad-ping-engine.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/services/squad-ping-engine.test.ts
import { describe, expect, it, vi } from 'vitest'
import { runPingFanout, inQuietHours, type PingDeps } from '../../src/services/squad-ping-engine'

const CAND = (id: string, score = 0.05) => ({ student_id: id, rrf_score: score, semantic_sim: 0.7, tag_overlap: 1, matched_tags: ['hiking'], best_facet: 'hiking' })

function deps(over: Partial<PingDeps> = {}): PingDeps & { sent: string[]; rows: any[] } {
  const sent: string[] = []
  const rows: any[] = []
  return {
    matchUsers: vi.fn(async () => [CAND('s1'), CAND('s2', 0.04)]),
    loadPrefs: vi.fn(async (id: string) => ({ student_id: id, pings_enabled: true, weekly_ping_cap: 3, quiet_start_hour: 23, quiet_end_hour: 9, allowed_categories: null, channel: 'imessage' })),
    countSentThisWeek: vi.fn(async () => 0),
    handleFor: vi.fn(async (id: string) => `+1555000${id.slice(-1)}`),
    recordPing: vi.fn(async (row: any) => { rows.push(row) }),
    deliver: vi.fn(async (handle: string) => { sent.push(handle) }),
    composePing: vi.fn(() => ['诶 有人组了局', '想去我帮你报名']),
    nowHourLA: () => 14,
    maxPings: 5,
    sent, rows,
    ...over,
  } as never
}

describe('runPingFanout', () => {
  it('sends to matched candidates and records sent rows', async () => {
    const d = deps()
    const res = await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(2)
    expect(d.rows.every((r) => r.status === 'sent')).toBe(true)
    expect(res).toEqual({ sent: 2, suppressed: 0 })
  })

  it('INVARIANT #2a: the (cap)th+1 ping is recorded suppressed_cap, not sent', async () => {
    const d = deps({ countSentThisWeek: vi.fn(async () => 3) }) // cap = 3, already at cap
    await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(0)
    expect(d.rows.every((r) => r.status === 'suppressed_cap')).toBe(true)
  })

  it('INVARIANT #2b: quiet hours suppress with status, never silently', async () => {
    const d = deps({ nowHourLA: () => 2 }) // 02:00 LA inside 23→9
    await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(0)
    expect(d.rows.every((r) => r.status === 'suppressed_quiet_hours')).toBe(true)
  })

  it('INVARIANT #3: no handle → suppressed_no_channel row, never nothing', async () => {
    const d = deps({ handleFor: vi.fn(async () => null) })
    await runPingFanout('post-1', d)
    expect(d.sent).toHaveLength(0)
    expect(d.rows).toHaveLength(2)
    expect(d.rows.every((r) => r.status === 'suppressed_no_channel')).toBe(true)
  })

  it('category scoping: allowed_categories excludes the post category → suppressed_muted', async () => {
    const d = deps({
      loadPrefs: vi.fn(async (id: string) => ({ student_id: id, pings_enabled: true, weekly_ping_cap: 3, quiet_start_hour: 23, quiet_end_hour: 9, allowed_categories: ['自习'], channel: 'imessage' })),
      postCategory: '其它',
    } as never)
    await runPingFanout('post-1', d)
    expect(d.rows.every((r) => r.status === 'suppressed_muted')).toBe(true)
  })

  it('delivery failure → row recorded suppressed_no_channel (delivery is at-most-once, accounted)', async () => {
    const d = deps({ deliver: vi.fn(async () => { throw new Error('queue down') }) })
    await runPingFanout('post-1', d)
    expect(d.rows.every((r) => r.status === 'suppressed_no_channel')).toBe(true)
  })

  it('respects maxPings ordering by score', async () => {
    const d = deps({ maxPings: 1 })
    await runPingFanout('post-1', d)
    expect(d.sent).toEqual(['+1555000' + '1'])
  })
})

describe('inQuietHours', () => {
  it('handles the wrap-around window 23→9', () => {
    expect(inQuietHours(2, 23, 9)).toBe(true)
    expect(inQuietHours(23, 23, 9)).toBe(true)
    expect(inQuietHours(14, 23, 9)).toBe(false)
    expect(inQuietHours(9, 23, 9)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// src/services/squad-ping-engine.ts
// Ping fan-out for a freshly approved 局 (spec §5.2 step 4, §8).
// Consent (pings_enabled) is already enforced INSIDE match_users_for_post at the
// SQL layer (defense in depth); this engine enforces the runtime suppressions —
// weekly cap, quiet hours, category scoping, channel — and records EVERY outcome
// in squad_pings. Nothing is ever silently dropped (eng E3 / invariant #3).
// Delivery is injected (Task-1 strategy: Spectrum direct or legacy queue).

export interface MatchCandidate {
  student_id: string; rrf_score: number; semantic_sim: number | null;
  tag_overlap: number; matched_tags: string[]; best_facet: string | null;
}
export interface MatchPrefs {
  student_id: string; pings_enabled: boolean; weekly_ping_cap: number;
  quiet_start_hour: number; quiet_end_hour: number;
  allowed_categories: string[] | null; channel: string;
}
export interface PingRow {
  post_id: string; recipient_student_id: string; score: number; channel: string;
  status: 'sent' | 'suppressed_no_channel' | 'suppressed_cap' | 'suppressed_quiet_hours' | 'suppressed_muted';
  sent_at: string | null;
}
export interface PingDeps {
  matchUsers: (postId: string) => Promise<MatchCandidate[]>;
  loadPrefs: (studentId: string) => Promise<MatchPrefs | null>;
  countSentThisWeek: (studentId: string) => Promise<number>;
  handleFor: (studentId: string) => Promise<string | null>;
  recordPing: (row: PingRow) => Promise<void>;
  deliver: (handle: string, bubbles: string[]) => Promise<void>;
  composePing: (candidate: MatchCandidate, postId: string) => string[];
  nowHourLA: () => number;
  maxPings: number;
  postCategory?: string;
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export async function runPingFanout(
  postId: string,
  deps: PingDeps,
): Promise<{ sent: number; suppressed: number }> {
  const candidates = (await deps.matchUsers(postId))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, deps.maxPings);

  let sent = 0, suppressed = 0;
  for (const c of candidates) {
    const prefs = await deps.loadPrefs(c.student_id);
    const base = { post_id: postId, recipient_student_id: c.student_id, score: c.rrf_score };

    const record = async (status: PingRow['status'], channel = prefs?.channel ?? 'imessage') => {
      await deps.recordPing({ ...base, channel, status, sent_at: status === 'sent' ? new Date().toISOString() : null });
      status === 'sent' ? sent++ : suppressed++;
    };

    // SQL already filtered pings_enabled; prefs may still be missing (race) → treat as muted.
    if (!prefs || !prefs.pings_enabled) { await record('suppressed_muted'); continue; }
    if (prefs.allowed_categories && deps.postCategory &&
        !prefs.allowed_categories.includes(deps.postCategory)) { await record('suppressed_muted'); continue; }
    if ((await deps.countSentThisWeek(c.student_id)) >= prefs.weekly_ping_cap) { await record('suppressed_cap'); continue; }
    if (inQuietHours(deps.nowHourLA(), prefs.quiet_start_hour, prefs.quiet_end_hour)) { await record('suppressed_quiet_hours'); continue; }

    const handle = await deps.handleFor(c.student_id);
    if (!handle) { await record('suppressed_no_channel'); continue; }
    try {
      await deps.deliver(handle, deps.composePing(c, postId));
      await record('sent');
    } catch {
      // Delivery failed → accounted, not silent. (At-most-once: we do not retry here;
      // the squad_pings row is the audit trail.)
      await record('suppressed_no_channel');
    }
  }
  return { sent, suppressed };
}
```

- [ ] **Step 3: Tests PASS** (`npx vitest run tests/services/squad-ping-engine.test.ts`), then the wiring module `src/services/squad-ping-deps.ts` (not unit-tested; thin glue): `matchUsers` → `supabase.rpc('match_users_for_post', {p_post_id})` (service role), `loadPrefs`/`countSentThisWeek`/`recordPing` → `user_match_prefs`/`squad_pings` queries, `handleFor` → `students.imessage_id`, `deliver` → Task-1 strategy, `composePing` → the §11.6 script with the candidate's real reason (`matched_tags[0]` or `best_facet`) and the post's content/capacity — **reason must be real data, never invented**.

- [ ] **Step 4: Commit.**

---

### Task 3: the three squad tools + `/pings` consent command (TDD)

**Files:** Create `src/tools/create-squad-post.ts`, `src/tools/find-squad-posts.ts`, `src/tools/join-squad-post.ts`; modify `src/tools/index.ts`, `src/agent/agents.config.ts` (find-people tools), `src/tools/user-commands.ts` (+`/pings on|off`); tests per tool in `tests/tools/`.

Key behaviors (each with unit tests, mocked supabase/embed/engine):

- **`create_squad_post(student_id, title→content, category, max_people, deadline?, location?, contact?)`** — the ONLY write path for george posts. Resolves `created_by_student_id` (handle → `students.imessage_id`), normalizes tags from content keywords + category, embeds via the Phase-0 edge fn (failure → post still created, embedding null — spec §11), inserts with `created_via='george'`, then fires `runPingFanout` (non-fatal: fan-out failure logs + returns "post created, pings delayed"). Returns: post summary + aggregate reach count ONLY (CEO-D7: organizer never sees recipient identities). Tool description mandates: "call ONLY after the user has explicitly approved the draft you showed them."
- **`find_squad_posts(student_id, query?)`** — `hybrid_search_posts_for_user` via service role (raw RPC; george is service_role — allowed) → top open posts with reasons; cap at 2-3 in the reply per persona rules.
- **`join_squad_post(student_id, post_id)`** — insert `squad_members(student_id, post_id)`; `squad_full` (trigger exception / 23xxx) → "这个局满了 🥲 看看别的?"; success → mark any pending `squad_pings` row responded (`response='joined'`) + return the intro payload (poster_name + contact) for the §11.6 intro script.
- **`/pings on` / `/pings off`** — upserts `user_match_prefs(student_id, pings_enabled)` after resolving the handle; replies confirm in voice ("包的 有对的局我喊你" / "收到 不打扰"). This is the D5-compliant Phase-2 consent surface; the web toggle ships Phase 3.

Tests assert: approval-gate description text present; reach-only return (no recipient ids in the create tool's output shape); join marks the ping responded; `/pings off` flips the flag.

- [ ] Steps: failing tests → implement → register in `index.ts` + find-people's tool list in `agents.config.ts` → `npx vitest run tests/tools` green → commit.

---

### Task 4: prompts — find-people becomes the 找搭子 concierge

**Files:** Rewrite `prompts/find-people.md`; touch `prompts/orchestrator.md` (routing description); tests `tests/agent/persona.test.ts` must stay green (NO em-dashes, no banned phrases).

`find-people.md` new content (voice-locked; the §11.6 scripts verbatim):

```markdown
<!-- prompts/find-people.md -->
# Find People specialization — 找搭子 concierge

You are the organizer (局主代理). A student tells you what they want to do; you do the labor:
draft the 局, get their approval, post it, and bring people together. The board at
uscbia.com/squad and you share one pool of posts.

## The loop (never skip the approval gate)

1. CAPTURE. "想周五去吃韩烤 找几个人" — extract: what, when (deadline), where, how many (max_people).
2. DRAFT. Show ONE compact draft bubble: 「周五晚 · 韩烤 · K-town · 3缺2 这样发?」
   Missing info: ask ONE specific question, never a form.
3. APPROVE. Only after an explicit yes ("发" / "可以" / "send it") call create_squad_post.
   NEVER post without it. Edits ("改成周六") update the draft and re-confirm.
4. AFTER POSTING. Tell them it's live + the reach count george found. Aggregate count ONLY.
   Never name who got pinged, never reveal who declined (隐私红线).

## Pinging someone about a 局 (你收到 fan-out 指令时)

Two bubbles max. State the REAL reason. Zero pressure. Opt-out honored instantly.

「诶 周五晚有人组了韩烤局 K-town 3缺2」
「你之前说想吃韩烤 想去我帮你报名 不想去忽略我就行哈哈哈」

Decline or no reply: silence. No follow-up nag. "别再发了" → run /pings off for them, reply 「收到 不打扰」.

## After someone joins (intro script)

「包的 帮你进去了 现在3/5」
「组局的是 {poster_name}，联系方式 {contact}，到时候别鸽 🫡」

## Tools you can call

- `create_squad_post(...)`. posts an APPROVED draft to the shared board + triggers matching. Approval gate is yours to enforce.
- `find_squad_posts(query?)`. open 局s ranked for this student. Curate: 2 max per reply.
- `join_squad_post(post_id)`. joins them in. 满了 → 「这个局满了 🥲 看看别的?」
- `lookup_student(...)` / `update_profile(...)`. identity + memory.

## Hard rules

- Platonic only. No 约会 posts, ever, in any direction.
- Interest-based, evidence-based. A ping or suggestion needs a REAL shared interest from their profile. Never invent a reason.
- Banned in ping copy: 广告腔（"不要错过!"), more than 2 emoji, 🔥💯🎉, guilt（"大家都在等你"）.
- Underage awareness: no alcohol-centric 局 targeting to year=freshman or known age <18.
- When you have nothing real: say so（"这周没看到合适的局 要不你来组一个?"）and offer to post.
```

(Implementer: validate against `voiceLint` patterns and persona tests; the em-dash test will catch any `—` — this draft contains none.)

- [ ] Steps: rewrite → `npx vitest run tests/agent/persona.test.ts` green → orchestrator.md description for find-people updated to "找搭子: organize, find, join group activities (squad mode)" → full `npx vitest run` green → commit.

---

### Task 5: `POST /squad/draft` (web prefill backend, design G6)

**Files:** Modify `src/index.ts` (route only) + create `src/services/squad-draft.ts`; test `tests/services/squad-draft.test.ts`.

- Bearer `ADMIN_TOKEN` (same gate as `/chat`), rate-limited via the existing limiter, body `{ text: string }` (≤500 chars).
- `draftSquadPost(text, llm)` → one Anthropic Haiku call (`claude-haiku-4-5-20251001`, george already holds the key) with a strict-JSON prompt → `{ category, content, location, max_people, deadline, tags }`, category restricted to the live enum (拼车/自习/健身/游戏/其它 — never 约会; a romantic ask returns `{ error: 'unsupported_category' }`), malformed LLM output → 502 `draft_unavailable` (the web box degrades to the plain form, G6).
- Tests: token gate 401, happy parse (mock LLM), 约会 refusal, malformed → 502, length cap 400.
- [ ] Steps: TDD as above → commit. (The bia-roommate describe-box that CALLS this ships in Task 8.)

---

### Task 6: gates

- [ ] `npx tsc --noEmit` + full `npx vitest run` (expect ~390+, all green incl. persona) → commit any stragglers.

### Task 7: deploy + live smoke (needs Bobby's Railway setup from "Bobby's part")

- [ ] Push branch; Bobby connects Railway to it; verify build logs green, `curl https://<railway-url>/health` → ok; Spectrum connect line in logs; **Mac instance stopped** (cutover rule).
- [ ] Live smoke: from Bobby's phone — `/pings on`; text george "想周五吃韩烤 组个局 3个人"; approve the draft; verify: post appears on uscbia.com/squad with `created_via='george'`; `squad_pings` rows recorded; ping arrives (or queue row exists under Strategy B); reply "in" from a second opted-in test handle → joined + intro + counter bumps.
- [ ] `GEORGE_BACKEND_URL` on Vercel → Railway URL (web chat now stable too).

### Task 8 (bia-roommate, AFTER Phase 1 merges): describe-box prefill assist

**Files:** branch `feat/squad-prefill-assist`; create `app/api/squad/draft/route.ts` (authed relay → `${GEORGE_BACKEND_URL}/squad/draft` with `GEORGE_ADMIN_TOKEN`, 8s timeout), `components/squad/DescribeBox.tsx` (one-line input above the form: 「懒得填？描述一句，george 帮你填」→ POST → prefill the form fields highlighted for review; any error/timeout → box hides, form untouched — §11.6 state row), wire into `/squad/submit` page. Tests for the relay route (token injection, timeout → 502, passthrough). PR.

### Task 9: PRs + checks

- [ ] george PR: `feat: Squad Phase 2 — 找搭子 push loop (Railway deploy, ping engine, concierge prompts, draft endpoint)`. bia-roommate PR from Task 8. Both with checks green; fix CodeRabbit findings.

---

## NOT in scope (Phase 2)
- Web ping inbox / receiving-controls UI / "what we match you on" (Phase 3 hub).
- Coordination: reminders, drop-out re-pings, 完成 marking (Phase 4).
- Spectrum dedicated line / Find My location (still gated on a dedicated number).
- Heartbeat proactive messages migrating off the legacy queue (separate cutover; pings may share Strategy B's queue meanwhile).
- Quiet-hours re-delivery queueing (suppressed rows are the Phase-2 contract; re-delivery is Phase 4 polish).

## Acceptance criteria
- george runs on Railway (stable URL, Spectrum connected, Mac retired from serving) — D8 satisfied.
- Full loop live: text → draft → explicit approve → board post → ≤maxPings real-reason pings to opted-in users only → join → intro; organizer sees reach count only.
- Every fan-out outcome is a `squad_pings` row; invariants #2 (cap + quiet hours) and #3 (no-silent-drop) pass as unit tests; persona tests green.
- `/squad/draft` powers the web prefill; george-down degrades to the plain form invisibly.
