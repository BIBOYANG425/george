# HANA Rollout Readiness — "Switch George to HANA" staged flip plan

> **For Bobby.** Every HANA-inspired human-realism feature is **built, wired, and tested** in George, each behind a flag that **defaults OFF in code** (so any unset flag = byte-identical legacy behavior). "Switching George to HANA" = turning these on **in stages** via Railway env, validating voice + behavior between each, not all at once. This doc is the single-look map: what each flag does, its risk, its prerequisite, and the order to turn them on.
>
> **Date:** 2026-06-24. **Scope:** the reactive iMessage line (Spectrum) + heartbeat. Voice is the product — every flag that changes what George *says* gets a human read before it goes live.

## Current prod state — VERIFY before flipping (do not assume)

The defaults above are the **code** defaults; the **live `george` Railway service** may already override several. Per the 2026-06-21 companion-feel activation, this band was flipped **ON in prod**: `MEMORY_CAPTURE_ENABLED`, `GEORGE_OBSERVE_ENABLED`, `GEORGE_RECALL_ENABLED`, `GEORGE_REFLECT_ENABLED`, `GROUNDED_PROACTIVE_ENABLED`, `GEORGE_MEMORY_PROACTIVE_ENABLED`, `HEARTBEAT_ENABLED`. So Bands 1, 2 (recall), and 4 (memory-proactive) are **likely already live** — treat them as "verify it's still ON," not "turn on." What's most likely **still OFF and genuinely new to flip**: **Band 0 `GEORGE_PACING_ENABLED`** (new, this work), the **Band 3 voice-tone flags** (`GEORGE_ACTIVITY_STATE_ENABLED`, `WORLD_STATE_ENABLED`, `GEORGE_NOREPLY_ENABLED`), `GEORGE_RELATIONSHIP_EVAL_ENABLED`, and the architecture flags (`SINGLE_AGENT`, `GEORGE_TRUNK_HYBRID`). **Check each flag's current value in the Railway dashboard first** — this doc gives the safe order and risk for whatever is still off; it does not assert the live value of any flag.

## Why staged, not a big-bang flip

The Mastra-migration spike concluded **NO-GO** on a framework rewrite ([`2026-06-21-mastra-migration-spike-go-no-go.md`](2026-06-21-mastra-migration-spike-go-no-go.md)); the human-feel comes from the **patterns**, which are already native in George. Turning them all on at once would stack N untested behavioral changes onto a live private beta and make a voice regression impossible to bisect. Flip one band at a time, dogfood a day, keep each flag as its own rollback.

## How to flip (mechanics)

Flags are **Railway env vars** on the `george` agent service (project BIA_AI / production), set to `true`. The agent does **not** auto-deploy on push — after setting a var, redeploy the agent (`railway up` / Railway "Deploy"). Each flag's OFF default means unsetting it is a clean, instant rollback. Set only one band per deploy; watch the PR #18 latency/cost telemetry + read a few real threads before the next.

## The flags (grouped by band, in recommended flip order)

Status legend: **Built+tested** = code merged, unit-tested, OFF in prod. **Voice-review** = flipping changes what George *says*; read sample outputs first. **Migration-gated** = a bia-admin migration must be applied before ON.

### Band 0 — Delivery realism (no voice change, lowest risk) → flip FIRST

| Flag | Default | What flipping ON does | Risk | Prereq |
|---|---|---|---|---|
| `GEORGE_PACING_ENABLED` | off | Bubble 0 inline; bubbles 2..N paced by length + persisted to a durable queue, drained restart-safely; fresh inbound cancels pending. | Low–med. Touches the live send path, but adversarially reviewed; degrades (not crashes) if the table is missing. | **Apply bia-admin#53** (`outgoing_bubbles`). Merge george#91. |
| `PACING_DRAIN_INTERVAL_MS` | 1000 | Drainer tick cadence. Leave at 1000. | None | — |

Band 0 changes *how* a reply arrives, not *what* it says — so it needs **no voice review**, just a functional smoke test (send a 3-bubble reply; restart the agent mid-burst; confirm the tail still lands). This is the cleanest first win and the headline HANA feel.

### Band 1 — Memory capture (silent; makes George *remember*) → flip SECOND

| Flag | Default | What flipping ON does | Risk | Prereq |
|---|---|---|---|---|
| `MEMORY_CAPTURE_ENABLED` | off | Per-turn SMART-tier extraction writes durable facts to the 6-block profile (consent-gated). | Med. Async, fail-closed on consent; no user-visible text. Watch SMART token cost. | `user_profiles` (already live). Consent flags. |
| `GEORGE_OBSERVE_ENABLED` | off | Logs episodic observations to `user_observations` (P6 observer). | Med. DB writes; no user-visible text. | **Apply** the P6 `user_observations` migration. |

These are *silent* — they change what George knows next time, not what he says now. Safe to run a few days to build a memory corpus **before** turning on recall (Band 2), so recall has something to surface.

### Band 2 — Memory recall + relationship (CHANGES VOICE) → flip THIRD, with a read

| Flag | Default | What flipping ON does | Risk | Prereq |
|---|---|---|---|---|
| `GEORGE_RECALL_ENABLED` | off | Per-turn semantic recall of past observations injected into the prompt → George references things you told him before. | **Voice-review.** Recall content steers replies. | Band 1 (`GEORGE_OBSERVE_ENABLED`) on first, with corpus. |
| `GEORGE_RELATIONSHIP_EVAL_ENABLED` | off | Every ~5 msgs, rewrites a short prose relationship note (SMART tier) injected each turn → warmth/continuity. | **Voice-review.** Note tone bleeds into voice. | `user_profiles.relationship_note` column (applied). |
| `GEORGE_RECALL_TOOL_ENABLED` | off | Exposes the deliberate `recall_memory` tool (precision counterpart to auto-recall). | Voice-review (minor). | Same as recall. |
| `GEORGE_UPDATE_MEMORY_TOOL_ENABLED` | off | Exposes `update_memory` so George saves one fact mid-reply. | Voice-review (minor). | Consent. |

Read 10–20 real threads after this band. This is where George starts *feeling* like he knows the student — the core HANA payoff and the biggest voice-regression surface.

### Band 3 — Ambient state & timing tone (CHANGES VOICE) → flip FOURTH

| Flag | Default | What flipping ON does | Risk | Prereq |
|---|---|---|---|---|
| `GEORGE_ACTIVITY_STATE_ENABLED` | off | Injects an in-voice note about George's plausible state (late-night/asleep/in-class) + a "sorry, was asleep" note after a long gap. **No response delay.** | **Voice-review.** `.env.example` explicitly says human voice review before enabling. | — |
| `WORLD_STATE_ENABLED` | off | Keeps a charged topic (visa/finals/homesick/job-hunt) warm a few turns as a sticky note. Ephemeral, no DB. | **Voice-review.** | — |
| `GEORGE_NOREPLY_ENABLED` | off | Lets George emit `{{NO_REPLY}}` to decline a pure-ack/automated text. | **Voice-review.** Risk = staying silent when he should reply; read for false silences. | — |
| `GEORGE_READRECEIPT_DELAY_ENABLED` (+`_MS`) | off / 0 | Pre-generation "reading" pause. The only sanctioned intentional delay. | Low (pre-gen only). Optional. | — |

### Band 4 — Proactive outreach (George TEXTS FIRST) → flip LAST, most caution

| Flag | Default | What flipping ON does | Risk | Prereq |
|---|---|---|---|---|
| `GROUNDED_PROACTIVE_ENABLED` | off | Heartbeat proactive nudges are grounded in a real open thread (a question George asked) or stay silent. | **Voice + UX.** George initiating. Consent/cadence/quiet-hours already gate it. | Heartbeat on; `proactive_raised_threads`. |
| `GEORGE_MEMORY_PROACTIVE_ENABLED` | off | Heartbeat may check in on a remembered observation ("how'd that CSCI 270 final go?"). | **Voice + UX.** Highest-touch. Deliberate flip. | Band 1 memory corpus. |
| `SQUAD_REREACH_EVAL_ENABLED` | off | Cron re-reach for stalled squad candidates. | Med (outbound sends). | Squad live. |

Proactive = George reaching into someone's day unprompted. Turn on only after Bands 1–3 are stable, start with a tiny allow-list if possible, and watch opt-outs.

## Architecture track (separate from flag-flips)

- `GEORGE_TRUNK_HYBRID` / `SINGLE_AGENT` (both default-off): collapse the orchestrator + 3 sub-agents into the HANA-shaped single trunk agent + dispatched specialists. This is the deepest structural HANA-alignment but is **not yet shippable** — the trunk path has open must-fixes and no OFF-path equivalence test (per [`2026-06-19-trunk-hybrid-restructure-design.md`](2026-06-19-trunk-hybrid-restructure-design.md)). Treat as its own workstream, not part of this flag rollout.

## One-glance recommended order (for whatever is still OFF — verify first)

0. **Apply the pending migration** (bia-admin#53 `outgoing_bubbles`) — no behavior change. (The P6 `user_observations` migration was already applied 2026-06-21.)
1. **Band 0** `GEORGE_PACING_ENABLED` — the genuinely new one. Functional smoke test (3-bubble reply, restart mid-burst, tail still lands), no voice read.
2. **Bands 1–2 memory/recall + Band 4 memory-proactive** — *likely already ON* since 2026-06-21; **verify** they're still set, don't re-toggle blindly. If any got reset, re-enable in the silent-first order (capture/observe → recall → reflect → proactive) and read threads after recall.
3. **`GEORGE_RELATIONSHIP_EVAL_ENABLED`** (if still off) — **read threads** (note tone bleeds into voice).
4. **Band 3** `GEORGE_ACTIVITY_STATE_ENABLED` + `WORLD_STATE_ENABLED` (+ `GEORGE_NOREPLY_ENABLED`) — the voice-tone band, almost certainly still off; **read threads** after each.
5. **Architecture** (`SINGLE_AGENT`) — a separate burn-in, now CI-guarded by the OFF-path equivalence test; trunk-hybrid was eval-judged HOLD-OFF on quality, so do not flip `GEORGE_TRUNK_HYBRID`.

Each flip: set the var → redeploy `george` (`railway up`) → validate → next. Any regression: unset the flag → redeploy → instant rollback.
