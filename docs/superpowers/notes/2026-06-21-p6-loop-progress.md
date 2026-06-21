# P6 build loop — progress + charter (autonomous /loop)

> **Loop window:** 2026-06-21 08:46Z → **16:46Z** (8h). Stop scheduling wakeups after 16:46Z.
> **Mandate:** "finish building and switch to hana based on your intuitions of what next." Self-paced.
> **Branch:** `feat/p6-observational-memory`. **Spec:** `docs/superpowers/specs/2026-06-21-p6-observational-memory-design.md`.

## Autonomy boundaries (POST-COMPACTION ME: OBEY THESE)

**DO autonomously:**
- Write code / migration FILES / tests; run `tsc --noEmit` + `vitest run` locally after each task.
- subagent-driven-development: implementer → spec-reviewer → quality-reviewer per task.
- Open PRs; merge PRs that are CI-green AND reviewed AND default-OFF (the build flow).
- Update this progress doc + the roadmap memory each chunk.

**HOLD for Bobby (DO NOT do unattended — park in the activation checklist):**
- Apply any migration to PROD (Supabase MCP apply_migration / execute_sql DDL).
- Deploy to prod (`railway up`) — outward-facing, resets the Spectrum transport.
- Flip ANY prod flag ON (`railway variable set`). All P6 flags ship default-OFF.
- Any destructive/irreversible prod change, restart, or paid eval run (Opus A/B costs $).

Reason: the user is AFK 8h; prod activation is hard-to-reverse + needs dogfooding. Code can be
FULLY built + CI-green without touching prod (tests mock the DB). Build to "ready", park activation.

## Plan
`docs/superpowers/plans/2026-06-21-p6-observational-memory.md` (4 phases).

## Phase status
- [x] Phase 0 — bia-admin migration FILE + PR **#32** (`user_observations` + `recall_observations` RPC + service_role grant). Prod-apply PARKED.
- [x] Phase 1 — Observer DONE. `src/memory/observations.ts` store seam (commit 81fffac, 21 tests) + `src/memory/capture.ts` Observer (commit 2896014, gated `GEORGE_OBSERVE_ENABLED`). Full suite 817 passed, tsc clean.
- [x] Phase 2 — Recall DONE. `src/memory/recall.ts` (commit 1233d85, 13 tests) + injected into all 4 paths orchestrator/single/trunk/fast (commit 904677e, gated `GEORGE_RECALL_ENABLED`). Full suite 838 passed, OFF byte-identical verified.
- [x] Phase 3 — DONE. Reflector + prune in heartbeat (commit d8f2a71, gated `GEORGE_REFLECT_ENABLED`, observationDB wired into index.ts) + `/delete me` wipes user_observations (7 tables now, commit b7661cc) + `.env.example` P6 section. Full suite 849 passed, tsc clean.

## P6 COMPLETE — PR #58 (george), depends on bia-admin #32 (migration)
All 4 phases built, final review done (SHIP-WITH-FIXES → all fixed), 854 passed/11 skip, tsc clean.
Final-review fixes (commit 3da7633): wired RECALL_HALF_LIFE_DAYS through to RPC; env-parse consistency; recall/history Promise.all; comment accuracy.

## Bobby's P6 activation checklist (post-merge — DO NOT auto-run)
1. Merge + apply bia-admin **PR #32** migration to prod (`user_observations` + `recall_observations` RPC); verify `to_regclass('public.user_observations')` non-null.
2. Merge george **PR #58** (if not already) + deploy (default-OFF code = byte-identical, safe).
3. Dogfood flags one at a time on /georgebeta: `GEORGE_OBSERVE_ENABLED` (accumulate log) → `GEORGE_RECALL_ENABLED` (the payoff) → `GEORGE_REFLECT_ENABLED`.

## Log (newest first)
- 09:5xZ — P6 COMPLETE. Final review + all fixes done. PR #58 opened (george), bia-admin #32 (migration). 854 passed. Next: verify #58 CI → merge if green (default-OFF, reviewed) → switch to next HANA build (assess PR #34 evaluator family).
- 09:3xZ — Phase 3 DONE. All 4 phases built. Full suite 849 passed/11 skip, tsc clean.
- 09:1xZ — Phase 2 DONE (recall module + 4-path injection). Full suite 838 passed/11 skip, tsc clean. Next: Phase 3 (Reflector/prune/delete/docs) = final phase, then one feature PR.
- 09:0xZ — Phase 1 DONE (observations seam + Observer). Full suite 817 passed/11 skip, tsc clean. Branch pushed. Next: Phase 2 recall.
- 08:5xZ — Phase 0 done: bia-admin PR #32 (migration + RPC, additive). Starting Phase 1 (george Observer).
- 08:46Z — loop started. Spec done + committed (d59d8c6). Plan + charter committed (64a04e1).

## Bobby's activation checklist (fill as phases complete)
1. **Apply bia-admin migration to prod:** PR #32 (`20260621130000_p6_user_observations.sql`) — adds `user_observations` + `recall_observations` RPC. Merge + apply to prod (Supabase MCP `apply_migration`), verify `to_regclass('public.user_observations')` non-null.
2. _(deploy default-OFF george code → dogfood flags observe→recall→reflect on /georgebeta — fill as phases land)_
