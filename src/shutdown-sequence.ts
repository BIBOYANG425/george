// src/shutdown-sequence.ts
// The graceful-shutdown ORDERING, extracted as a pure, injectable helper so the
// load-bearing step order is unit-testable without booting the HTTP server or the
// real transport adapters (which need spectrum-ts / macOS-native bindings).
//
// The order is the whole point:
//   1. stopHttp     — stop accepting new HTTP connections.
//   2. stopIntake   — stop inbound intake on EVERY transport so no NEW orchestrator
//                     turn begins, WITHOUT closing the transport clients.
//   3. drain        — drain in-flight fire-and-forget turns WHILE the clients are
//                     still live, so a mid-generation reply can still SEND.
//   4. closeClients — tear the transport clients down only now that in-flight turns
//                     have flushed their replies.
//
// An earlier version closed the Spectrum client (app.stop → app.send fails) BEFORE
// the drain, so an in-flight reply was silently lost — exactly the loss the drain
// exists to prevent. Keeping close AFTER drain is the fix.
//
// Header last reviewed: 2026-07-07

// Generic in the drain outcome (D) so this stays decoupled from the in-flight
// registry's DrainResult shape — the caller passes its own drain fn and gets its
// result back verbatim.
export interface ShutdownSteps<D> {
  // Stop accepting new HTTP connections (in-flight requests finish naturally).
  stopHttp: () => void
  // Stop inbound intake on every transport so NO new orchestrator turns begin,
  // WITHOUT closing the clients (they must stay live for the drain).
  stopIntake: () => Promise<void>
  // Drain in-flight fire-and-forget turns while the clients are still live.
  drain: () => Promise<D>
  // Close the transport clients now that in-flight turns have flushed their replies.
  closeClients: () => Promise<void>
}

// Run the shutdown steps in the fixed, load-bearing order and return the drain
// outcome. Each step is awaited in turn: closeClients is never invoked until the
// drain promise has resolved.
export async function runShutdownSequence<D>(steps: ShutdownSteps<D>): Promise<D> {
  steps.stopHttp()
  await steps.stopIntake()
  const drain = await steps.drain()
  await steps.closeClients()
  return drain
}
