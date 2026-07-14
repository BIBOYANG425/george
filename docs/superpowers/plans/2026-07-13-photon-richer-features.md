# george × Photon: richer Spectrum features

Enable the Spectrum/Photon capabilities george isn't using yet, informed by
spool-agent ("Chris"). george ALREADY has agent-directed tapbacks
(`react_to_user` tool → `reply.react`) and persona for them — that's not a gap.
All content types below are confirmed present in `spectrum-ts` 3.1.0
(`attachment`, `reaction`, `location`, `poll`, `richlink`; `message.reply()`).

**Constraints:** every phase is default-safe (feature-flagged or additive),
keeps the reply path non-blocking, and is visitor-facing → persona copy goes
through `prompts/master.md`, ping Bobby before enabling in prod. One PR per phase.

## Shared foundation (Phase 0) — stop dropping non-text content
`spectrum.ts:285` `if (message.contentType !== 'text') continue` throws away
attachments, reactions, and location. Replace the hard `continue` with routing:
text → today's path; attachment/reaction/location → their handlers (below);
unknown → skip. This single change unblocks 3 input features. Extend
`InboundMessage` with an optional `attachments?`, `reaction?`, `location?`.

## Phase 1 — Inbound images (highest value: george becomes multimodal)
Students send screenshots (schedules, listings, receipts); george is blind to them.
- Spectrum: inbound `content.type === 'attachment'` carries `mimeType` + `read(): Promise<Buffer>`. Download image bytes (guard: image/* mime, size cap, count cap).
- Pipeline: thread image blocks into the orchestrator's Claude `query()` as image content (Agent SDK supports image blocks). Non-image attachments → a text note ("[sent a PDF]").
- Persona: master.md — george can see images now; describe what he sees, never invent.
- Flag `GEORGE_IMAGE_INTAKE_ENABLED` (default OFF).

## Phase 2 — Threaded replies (reply to a specific message in a burst)
- `MessageHandleCache` (bounded TTL+size, keyed by guid) — reusable pattern from spool-agent's `message-cache.ts`. Retain inbound `Message` objects so a later `message.reply()` can thread.
- Orchestrator output: a `{{REPLY_TO:<n>}}` directive (n = index in the numbered burst) OR extend the reply path to thread to the triggering message. Single-message bursts never thread.

## Phase 3 — Read inbound tapbacks (engagement signal)
- Inbound `content.type === 'reaction'` → `{emoji, target guid}`. Note it (memory/observation: "user 👍'd your message"); optionally let it stand as an ack that suppresses a redundant reply.
- Feed into obs (`obs_messages` as a reaction row) + memory capture.

## Phase 4 — Location sharing (inbound + spatial tools)
- Inbound `content.type === 'location'` → `{latitude, longitude}`. Wire into the spatial layer (`safe_route`, `travel_time`, `distance_compare`) so "is it safe to walk here?" uses the student's real shared pin instead of asking for an address.
- Outbound: george can send a location pin (e.g., a meetup spot) via the location content builder.

## Phase 5 — Rich links (mini-app cards)
- Outbound `richlink` content: when george shares an event / housing listing / link, send it as a rich preview card (url + title) instead of a bare URL.
- Agent tool `share_rich_link(url, title)` gated so it's used deliberately (events, listings), persona-calibrated (curate, don't spam).

## Phase 6 — Polls
- Outbound `poll` content: george posts a poll ("which dorm? A/B/C") in a group or DM.
- Inbound poll-vote handling: capture votes → surface the tally.
- Agent tool `create_poll(question, options[])`; persona rules (use for genuine group decisions, not gimmicks). Largest phase — group-chat semantics.

## Order rationale
Phase 0 first (unblocks 1/3/4). Then 1 (biggest value), 3 (cheap, same input path),
2 (reply threading), 4 (spatial synergy), 5, 6 (largest). Each ships behind a flag,
default OFF, verified, then enabled with Bobby's sign-off.
