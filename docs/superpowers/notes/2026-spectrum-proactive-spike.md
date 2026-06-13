# Spike: Spectrum proactive send (ping delivery strategy)

**Date:** 2026-06-13
**Question (plan Task 1):** Can george send to a conversation by handle WITHOUT an inbound message in hand, on the shared pool? This decides how `squad_pings` get delivered.

## Finding — YES, the API exists

`spectrum-ts` exposes an instance-level space namespace (confirmed in
`node_modules/spectrum-ts/dist/types-Be0T6E0e.d.ts`):

```ts
interface SpaceNamespace<Def> {
  // "Resolve or create a space from its participants — a single user (1:1
  //  conversation) or several (group). Users may be raw id strings or
  //  previously resolved PlatformUsers."
  create(users: SpaceUserLike | SpaceUserLike[], ...params): Promise<PlatformSpace<Def>>;
  get(id: string, ...params): Promise<PlatformSpace<Def>>;
}
// PlatformInstance<Def> = { readonly messages: …; readonly space: SpaceNamespace<Def>; user(id): … }
```

So from the connected app: `const sp = await app.space.create(handle); await sp.send(text)` opens (or resolves) a 1:1 DM to a raw handle string and sends — no prior inbound required. `Space.send(ContentInput)` is the same send used on the reactive path.

Verified empirically during the Railway/onboarding work: george delivers outbound on multiple per-user lines on the shared pool (the `[spectrum OUT] … ok` logs), and the onboarding greeting is a proactive multi-bubble send to a handle that just texted in. The 1:1 space send path is exercised and working.

## Decision — Strategy A (Spectrum direct). It is REQUIRED, not just preferred.

Strategy B in the plan (the legacy `imessage_outgoing` queue) is drained by the
**iPhone Shortcut (Path B)**, which was **retired at the Railway cutover** (Mac
stopped serving). On the cloud-only setup there is nothing draining that queue, so
B cannot deliver a ping. Therefore ping delivery MUST use the live Spectrum
connection.

## Engine interface (unchanged from the plan)

The ping engine takes an injected `deliver(handle, bubbles): Promise<void>`. Strategy A wires it to a new seam method:

```ts
// add to SpectrumClient (src/adapters/spectrum-client.ts): proactive send
sendProactive(handle: string, bubbles: string[]): Promise<void>
//   real impl: const sp = await app.space.create(handle);
//              for (const b of bubbles) { await sendWithRetry(() => sp.send(b)); /* [spectrum OUT] log */ }
```

`squad_pings.status='sent'` means actually delivered over Spectrum; `channel='imessage'`.

## Caveats / notes

- Shared-pool proactive sends originate from the project's shared identity (same as the reactive replies). Ping recipients are opted-in students who, by E3, are already george-linked (they onboarded by texting george), so a routable thread exists / `space.create` resolves it.
- Delivery is **at-most-once**: the engine does not retry a failed `sendProactive`; a failure is recorded as `suppressed_no_channel` (the `squad_pings` row is the audit trail — invariant #3, no silent drop).
- If a future shared-pool routing quirk makes `space.create` unreliable for a cold handle, the one-line fallback is to swap `deliver` back to `enqueueOutgoing` once a cloud queue-drainer exists (out of Phase 2 scope).
