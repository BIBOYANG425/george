# TODOS

Organized by component, then priority (P0 highest → P4 lowest). Completed items
move to the bottom section with the version that shipped them.

## Heartbeat

### heartbeat `add_followup` tick errors on the DeepSeek gateway
**Priority:** P0

The heartbeat-quality eval fixture `exam_date_mention_triggers_followup` returns
outcome `error` (not a wrong judgment — the tick itself errors) on the local
DeepSeek gateway, which is also the prod heartbeat model. This drags the suite to
7/8 = 88%, under the 90% bar (`tests/eval/heartbeat-quality.test.ts`). Reproduces
stably across runs, so it's not a one-off flake.

Likely cause: DeepSeek's Anthropic-compatible endpoint not honoring the
`add_followup` tool-call format the heartbeat emits (vs a transient gateway error).
Investigate the raw tick error, confirm whether it's the tool-call schema or
transport, and fix so the heartbeat reliably schedules followups on DeepSeek.

Noticed by: gstack /ship during the admin-dashboard PR-1 sequence (2026-06-25).
Out of scope for the admin-dashboard work; logged here for separate follow-up.

## Completed

(none yet)
