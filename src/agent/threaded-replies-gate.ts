// src/agent/threaded-replies-gate.ts
//
// One place to apply the {{THREAD}} prompt gate to master.md. The threaded-reply
// opt-out instruction is authored in master.md between the GEORGE_THREAD_BEGIN/END
// sentinels so its wording sits with the other voice rules for human review.
// Every consumer that loads master.md (orchestrator + sub-agents via
// agents.config, the reactive fast-path, and the heartbeat) runs the raw file
// through applyThreadedRepliesGate() so the instruction is present iff the
// feature is on. Mirrors noreply-gate.ts exactly.
//
// Default OFF: when GEORGE_THREADED_REPLIES_ENABLED is not 'true', the whole block
// (and its surrounding blank lines) is removed, so every prompt is byte-for-byte
// what it was before this feature. The parser + send path in adapters are gated by
// the SAME flag, so the prompt instruction and the threading turn on together.

import { getFlags } from '../flags.js';

const THREAD_BLOCK = /\n*<!-- GEORGE_THREAD_BEGIN -->[\s\S]*?<!-- GEORGE_THREAD_END -->\n*/;

export function applyThreadedRepliesGate(master: string): string {
  if (getFlags().threadedRepliesEnabled) {
    // Keep the wording; only drop the sentinel comment lines so they aren't sent.
    return master
      .replace('<!-- GEORGE_THREAD_BEGIN -->\n', '')
      .replace('\n<!-- GEORGE_THREAD_END -->', '');
  }
  // Flag off (default): strip the block, collapsing it to the original blank line.
  return master.replace(THREAD_BLOCK, '\n\n');
}
