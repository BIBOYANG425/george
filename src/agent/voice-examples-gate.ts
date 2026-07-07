// src/agent/voice-examples-gate.ts
//
// Gate for the few-shot "How george texts (examples)" block in master.md. The
// examples are authored between the GEORGE_VOICE_EXAMPLES_BEGIN/END sentinels so
// they sit with the voice rules for human review. Every consumer that loads
// master.md (orchestrator + sub-agents via agents.config, the reactive fast-path
// via the MASTER_PROMPT constant, and the heartbeat which reads the file itself)
// runs the raw file through applyVoiceExamplesGate() so the block is present iff
// GEORGE_VOICE_EXAMPLES_ENABLED is 'true'.
//
// Why a flag: prose voice rules alone under-constrain register, so the model
// drifts to a long, caretaker, help-desk voice (the opposite of the founder's
// short-burst 学长 texting). Few-shot examples anchor brevity + register far more
// strongly. But they meaningfully change reactive voice, so they ship behind a
// flag for dogfooding + human red-pen before going live.
//
// Default OFF: when the flag is not 'true', the whole block (and its surrounding
// blank lines) is removed, so every prompt is byte-for-byte what it was before
// this feature. Mirrors ./noreply-gate.ts exactly.

import { getFlags } from '../flags.js';

const VOICE_EXAMPLES_BLOCK =
  /\n*<!-- GEORGE_VOICE_EXAMPLES_BEGIN -->[\s\S]*?<!-- GEORGE_VOICE_EXAMPLES_END -->\n*/;

export function applyVoiceExamplesGate(master: string): string {
  if (getFlags().voiceExamplesEnabled) {
    // Keep the examples; only drop the sentinel comment lines so they aren't sent.
    return master
      .replace('<!-- GEORGE_VOICE_EXAMPLES_BEGIN -->\n', '')
      .replace('\n<!-- GEORGE_VOICE_EXAMPLES_END -->', '');
  }
  // Flag off (default): strip the block, collapsing it to the original blank line.
  return master.replace(VOICE_EXAMPLES_BLOCK, '\n\n');
}
