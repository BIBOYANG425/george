// src/agent/noreply-gate.ts
//
// One place to apply the {{NO_REPLY}} prompt gate to master.md. The opt-out
// instruction is authored in master.md between the GEORGE_NOREPLY_BEGIN/END
// sentinels so its wording sits with the other voice rules for human review.
// Every consumer that loads master.md (orchestrator + sub-agents via
// agents.config, the reactive fast-path, and the heartbeat) runs the raw file
// through applyNoReplyGate() so the instruction is present iff the feature is on.
//
// Default OFF: when GEORGE_NOREPLY_ENABLED is not 'true', the whole block (and
// its surrounding blank lines) is removed, so every prompt is byte-for-byte what
// it was before this feature. The parser in adapters/split-response.ts is gated
// by the SAME flag, so prompt + suppression turn on together.

import { getFlags } from '../flags.js';

const NOREPLY_BLOCK = /\n*<!-- GEORGE_NOREPLY_BEGIN -->[\s\S]*?<!-- GEORGE_NOREPLY_END -->\n*/;

export function applyNoReplyGate(master: string): string {
  if (getFlags().noReplyEnabled) {
    // Keep the wording; only drop the sentinel comment lines so they aren't sent.
    return master
      .replace('<!-- GEORGE_NOREPLY_BEGIN -->\n', '')
      .replace('\n<!-- GEORGE_NOREPLY_END -->', '');
  }
  // Flag off (default): strip the block, collapsing it to the original blank line.
  return master.replace(NOREPLY_BLOCK, '\n\n');
}
