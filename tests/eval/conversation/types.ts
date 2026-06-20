// tests/eval/conversation/types.ts
//
// Shared interfaces for george's scored-conversation eval harness.
// Spec: docs/superpowers/specs/2026-06-20-george-eval-harness-design.md
//
// The harness drives the REAL orchestrator over JSON scenario fixtures, runs each
// reply through a deterministic voice/structure gate (hard fail), scores survivors
// with an Opus LLM-judge on george-defining dimensions, then A/Bs a default-OFF
// behavior flag (OFF vs ON) to decide a flip. These types are the contract every
// module (runner / gate / judge / report) shares.
//
// Header last reviewed: 2026-06-19

import type { Profile } from '../../../src/memory/profile.js';

// ── Scenario fixtures ──────────────────────────────────────────────────────

export type ScenarioCategory =
  | 'greeting'
  | 'course-advice'
  | 'housing'
  | 'social'
  | 'event'
  | 'safety-probe'
  | 'romantic-probe'
  | 'ai-identity'
  | 'cheating'
  | 'blind-spot'
  | 'unhinged'
  | 'flag-target';

export type ScenarioLang = 'en' | 'zh' | 'mixed' | 'other';
export type SplitName = 'train' | 'selection' | 'test';

// One conversational turn. The trailing user turn is the one george answers;
// prior turns seed <conversation_history> via the in-memory SessionStore.
export interface ScenarioTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Per-scenario assertions consumed by the deterministic gate (and, for gold
// scenarios, mustContainOneOf for fabrication-vs-fact). All optional so a plain
// scenario carries only what it needs.
export interface ScenarioExpect {
  // Substrings that must NOT appear (e.g. '626', invented prices/dorm names,
  // banned openers like 'Great question'). A substring hit is a hard gate fail.
  mustNotContain?: string[];
  // At least one of these substrings MUST appear — the gold-answer / canonical
  // deflection check. Used to catch the correct-but-hedged inverse failure that
  // a vibe-grading judge cannot (resolves the groundedness rubric gap).
  mustContainOneOf?: string[];
  // Probe categories (safety / romantic / ai-identity) require a canonical
  // deflection phrase AND no mirrored romantic line.
  deflectionRequired?: boolean;
  // NO_REPLY-class scenarios: ON must emit exactly {{NO_REPLY}}; OFF a short
  // human reply. Scored by assertion, never by pairwise preference (must-fix b).
  expectNoReply?: boolean;
  // Raise the default ~400-char ceiling for scenarios that legitimately asked
  // for more info.
  maxLenChars?: number;
  // Override the inferred reply language for mixed/ambiguous cases.
  expectLang?: 'en' | 'zh' | 'mixed';
}

export interface Scenario {
  id: string;
  category: ScenarioCategory;
  lang: ScenarioLang;
  turns: ScenarioTurn[];
  profile?: Partial<Profile>;
  // Which env flag(s) this scenario is designed to exercise, e.g.
  // ['GEORGE_NOREPLY_ENABLED']. Empty/absent = a baseline scenario.
  flagsUnderTest?: string[];
  expect: ScenarioExpect;
  split: SplitName;
  rationale: string;
}

export interface ScenarioFile {
  scenarios: Scenario[];
}

// ── Flag config (an A/B arm) ───────────────────────────────────────────────

// A named arm of the A/B. flags is the exact env overlay applied for this arm
// (the one flag under test set to 'true'/'false', plus pinned path flags). The
// runner snapshots, sets, then restores these in a finally block.
export interface FlagConfig {
  name: string; // 'OFF' | 'ON' (or arbitrary label)
  flags: Record<string, string>;
}

// ── Runner output ──────────────────────────────────────────────────────────

// One real orchestrator turn's captured result + telemetry.
export interface TurnRecord {
  scenarioId: string;
  flagConfigName: string;
  // The reply AFTER downstream {{NO_REPLY}} suppression has been replicated
  // (must-fix c). When the arm correctly suppressed, this is '' and suppressed
  // is true. rawReply holds the un-suppressed model text for debugging.
  reply: string;
  rawReply: string;
  suppressed: boolean;
  tools: string[];
  costUsd?: number;
  // Telemetry outcome string; 'fast_path' turns are excluded from the flag A/B
  // (must-fix f) because most flags don't touch the fast path.
  outcome?: string;
  durationMs?: number;
  // True when fastReply answered this turn (telemetry outcome === 'fast_path').
  fastPath: boolean;
  // Set when the orchestrator turn errored — recorded as an error arm, never
  // silently dropped.
  error?: string;
  // Positive activation check (must-fix g): did the flag observably activate on
  // the ON arm of a flag-target scenario? undefined when not applicable.
  flagActivated?: boolean;
}

// ── Gate ───────────────────────────────────────────────────────────────────

export interface GateFailure {
  rule: string;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  failures: GateFailure[];
}

// ── Judge ──────────────────────────────────────────────────────────────────

// The 5 approved dimensions. voiceFidelity is split into registerFit + restraint
// sub-scores (must-fix e) and the harness reward uses min(registerFit, restraint)
// so an optimizer cannot hill-climb voice into tic/emoji/slang slop.
export interface JudgeScore {
  registerFit: number; // 1-5: is it the unhinged senior?
  restraint: number; // 1-5: tics/slang/emoji used sparingly + only when they land?
  voiceFidelity: number; // derived = min(registerFit, restraint)
  groundedness: number; // 1-5
  helpfulness: number; // 1-5
  personaSafety: number; // 1-5
  taste: number; // 1-5
  rationale: string;
  judgeModel: string; // resolved model id, recorded for cross-run comparability
}

// A single pairwise judgment over OFF-reply A vs ON-reply B.
export interface PairwiseJudgment {
  // 'A' | 'B' | 'tie' in the RANDOMIZED presentation order; the caller maps back
  // to OFF/ON via the order it shuffled with.
  winner: 'A' | 'B' | 'tie';
  rationale: string;
  judgeModel: string;
}

// Aggregated repeated-sampling result for one (scenario, arm). Each dimension is
// the mean of k>=3 judge draws; sd is the per-dimension standard deviation so the
// report can show uncertainty and the flip guard can require a real effect
// (must-fix d).
export interface AggregatedJudge {
  scenarioId: string;
  flagConfigName: string;
  k: number;
  mean: Omit<JudgeScore, 'rationale' | 'judgeModel'>;
  sd: Omit<JudgeScore, 'rationale' | 'judgeModel'>;
  // reward = 0 if the deterministic gate failed (hard floor), else weighted sum
  // with voice = min(registerFit, restraint). The optimizer maximizes this.
  reward: number;
  rationales: string[];
  judgeModel: string;
}

// ── Report ─────────────────────────────────────────────────────────────────

export type DimKey =
  | 'registerFit'
  | 'restraint'
  | 'voiceFidelity'
  | 'groundedness'
  | 'helpfulness'
  | 'personaSafety'
  | 'taste';

export interface ArmAggregate {
  flagConfigName: string;
  gatePassRate: number;
  meanByDim: Record<DimKey, number>;
  sdByDim: Record<DimKey, number>;
  totalCostUsd: number;
  judgeCalls: number;
  candidateTurns: number;
}

export interface AbsoluteDelta {
  dim: DimKey;
  off: number;
  on: number;
  delta: number; // on - off
  // Pooled SD of the per-scenario means at this N. A delta is "real" only if it
  // exceeds this band (effect clears the noise floor) — not a bare epsilon.
  pooledSd: number;
  stdErr: number; // standard error of the mean delta across scenarios
  significant: boolean; // |delta| > significanceMargin AND |delta| > stdErr band
}

export interface PairwiseTally {
  onWins: number;
  ties: number;
  onLosses: number;
  n: number;
  // Two-sided sign-test p-value on (onWins vs onLosses), ties excluded. A flip
  // needs this to clear alpha, not just onWins > onLosses (must-fix d).
  signTestP: number;
}

export interface ABReport {
  flag: string;
  pathFlagsPinned: Record<string, string>;
  judgeModel: string;
  split: SplitName | 'all';
  gatePassRateOff: number;
  gatePassRateOn: number;
  gatePassRateDelta: number;
  absoluteDeltas: AbsoluteDelta[];
  // Full-set pairwise (excludes NO_REPLY-class flag targets — must-fix b).
  pairwiseFull: PairwiseTally;
  // Pairwise on the flag-target subset only (excludes NO_REPLY-class — must-fix b).
  pairwiseFlagTarget: PairwiseTally;
  // Assertion-based NO_REPLY metric (must-fix b): correct suppression on ON,
  // correct reply on OFF, over the pure-ack scenarios. Replaces pairwise there.
  noReplyMetric?: {
    onCorrectSuppressions: number;
    onTotal: number;
    offCorrectReplies: number;
    offTotal: number;
  };
  // ON-arm flag-activation rate on flag-target scenarios (must-fix g). A null
  // OFF-vs-ON delta with a LOW activation rate means "scenario never tripped the
  // flag", not "flag does nothing".
  flagActivation?: { activated: number; total: number };
  flipRecommendation: 'flip-on' | 'hold-off';
  // The single guard that decided the recommendation (the line a human acts on).
  decidingGuard: string;
  errorArms: number;
}

export interface CostSummary {
  candidateCalls: number;
  judgeCalls: number;
  totalUsd: number;
}

export interface FullReport {
  generatedAt: string;
  judgeModel: string;
  flag: string;
  scenarioRows: ScenarioRow[];
  armAggregates: ArmAggregate[];
  ab: ABReport;
  cost: CostSummary;
}

export interface ScenarioRow {
  id: string;
  category: ScenarioCategory;
  flagArm: string;
  split: SplitName;
  gatePass: boolean;
  gateFailures: GateFailure[];
  reply: string;
  suppressed: boolean;
  tools: string[];
  costUsd?: number;
  fastPath: boolean;
  flagActivated?: boolean;
  // Judge dims (present only when the judge ran).
  dims?: Record<DimKey, number>;
  reward?: number;
  rationale?: string;
}
