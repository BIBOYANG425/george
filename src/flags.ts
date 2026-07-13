// src/flags.ts
// One typed snapshot of george's boolean feature flags. Every default-OFF feature
// used to read `process.env.X === 'true'` inline in its own module; centralizing the
// reads here gives one place to see the flag surface and one spelling per flag.
//
// getFlags() RE-READS process.env on every call (it builds a fresh snapshot), so the
// established test pattern — flip an env var, then call the gated code — keeps working
// without module resets. It has no imports beyond process.env, so importing it is
// side-effect free (no config validation, safe on the dashboard boot path too).
//
// Topology: GEORGE_AGENT_MODE=trunk|single|multi is the canonical selector. When it
// holds a valid value it wins; when unset the legacy GEORGE_TRUNK_HYBRID / SINGLE_AGENT
// flags are honored unchanged (back-compat). `trunk` beats `single`, matching the
// orchestrator's existing precedence. Semantics with MODE unset are byte-identical to
// the previous inline reads.
//
// Header last reviewed: 2026-07-07

export type AgentMode = 'trunk' | 'single' | 'multi';

const on = (v: string | undefined): boolean => v === 'true';

// The canonical topology, or undefined when GEORGE_AGENT_MODE is unset/invalid (→ fall
// back to the legacy flags).
function resolveAgentMode(): AgentMode | undefined {
  const m = process.env.GEORGE_AGENT_MODE;
  return m === 'trunk' || m === 'single' || m === 'multi' ? m : undefined;
}

export interface Flags {
  // ── agent topology ──
  // Resolved topology: GEORGE_AGENT_MODE when set, else derived from the legacy flags
  // (trunk wins over single, else multi).
  agentMode: AgentMode;
  trunkHybrid: boolean;
  singleAgent: boolean;
  disableFastPath: boolean;
  // ── memory / recall ──
  recallEnabled: boolean;
  recallToolEnabled: boolean;
  updateMemoryToolEnabled: boolean;
  memoryCaptureEnabled: boolean;
  observeEnabled: boolean;
  memoryProactiveEnabled: boolean;
  reflectEnabled: boolean;
  // ── prompt overlays / voice ──
  activityStateEnabled: boolean;
  worldStateEnabled: boolean;
  voiceExamplesEnabled: boolean;
  relationshipEvalEnabled: boolean;
  noReplyEnabled: boolean;
  readReceiptDelayEnabled: boolean;
  // ── proactive / squads / crisis ──
  groundedProactiveEnabled: boolean;
  crisisRadarEnabled: boolean;
  squadCoordinationEnabled: boolean;
  squadRereachEvalEnabled: boolean;
  // ── spectrum transport ──
  burstGuardEnabled: boolean;
  pacingEnabled: boolean;
  // ── admin ──
  adminDashboardEnabled: boolean;
  // ── observability ──
  messageObservabilityEnabled: boolean;
}

export function getFlags(): Flags {
  const mode = resolveAgentMode();
  const legacyTrunk = on(process.env.GEORGE_TRUNK_HYBRID);
  const legacySingle = on(process.env.SINGLE_AGENT);
  return {
    agentMode: mode ?? (legacyTrunk ? 'trunk' : legacySingle ? 'single' : 'multi'),
    trunkHybrid: mode ? mode === 'trunk' : legacyTrunk,
    singleAgent: mode ? mode === 'single' : legacySingle,
    disableFastPath: on(process.env.GEORGE_DISABLE_FAST_PATH),
    recallEnabled: on(process.env.GEORGE_RECALL_ENABLED),
    recallToolEnabled: on(process.env.GEORGE_RECALL_TOOL_ENABLED),
    updateMemoryToolEnabled: on(process.env.GEORGE_UPDATE_MEMORY_TOOL_ENABLED),
    memoryCaptureEnabled: on(process.env.MEMORY_CAPTURE_ENABLED),
    observeEnabled: on(process.env.GEORGE_OBSERVE_ENABLED),
    memoryProactiveEnabled: on(process.env.GEORGE_MEMORY_PROACTIVE_ENABLED),
    reflectEnabled: on(process.env.GEORGE_REFLECT_ENABLED),
    activityStateEnabled: on(process.env.GEORGE_ACTIVITY_STATE_ENABLED),
    worldStateEnabled: on(process.env.WORLD_STATE_ENABLED),
    voiceExamplesEnabled: on(process.env.GEORGE_VOICE_EXAMPLES_ENABLED),
    relationshipEvalEnabled: on(process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED),
    noReplyEnabled: on(process.env.GEORGE_NOREPLY_ENABLED),
    readReceiptDelayEnabled: on(process.env.GEORGE_READRECEIPT_DELAY_ENABLED),
    groundedProactiveEnabled: on(process.env.GROUNDED_PROACTIVE_ENABLED),
    crisisRadarEnabled: on(process.env.GEORGE_CRISIS_RADAR_ENABLED),
    squadCoordinationEnabled: on(process.env.SQUAD_COORDINATION_ENABLED),
    squadRereachEvalEnabled: on(process.env.SQUAD_REREACH_EVAL_ENABLED),
    burstGuardEnabled: on(process.env.SPECTRUM_BURST_GUARD_ENABLED),
    pacingEnabled: on(process.env.GEORGE_PACING_ENABLED),
    adminDashboardEnabled: on(process.env.ADMIN_DASHBOARD_ENABLED),
    messageObservabilityEnabled: on(process.env.GEORGE_MESSAGE_OBSERVABILITY_ENABLED),
  };
}
