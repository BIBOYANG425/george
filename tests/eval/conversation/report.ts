// tests/eval/conversation/report.ts
//
// Pure aggregation: turns per-(scenario, arm) gate results + repeated-sampling
// judge draws into A/B deltas, a significance-gated flip recommendation, a scalar
// reward (for a future SkillOpt optimizer), a JSON report, and a markdown
// one-pager. NO LLM calls here — every function is deterministic and unit-tested.
//
// MUST-FIX 4 — repeated judge sampling + a real significance check: each
//   (scenario, arm) carries k>=3 draws; deltas are gated on an effect that
//   clears the measured noise band (stdErr) AND a minimum margin, not a bare
//   0.1/0.3 epsilon. Per-dimension SD + a pairwise sign-test p are reported so a
//   human sees the uncertainty, never just the point delta.
//
// MUST-FIX 2 — NO_REPLY-class flag targets are scored by an assertion metric
//   (correct suppression on ON, correct reply on OFF), NEVER by pairwise
//   preference, and are EXCLUDED from the pairwise tallies.
//
// MUST-FIX 5 — reward uses voiceFidelity = min(registerFit, restraint) so it
//   cannot be hill-climbed into tic/emoji/slang slop.
//
// MUST-FIX 7 — flag-activation is surfaced: a null OFF-vs-ON delta with a LOW
//   ON-arm activation rate reads as "scenario never tripped the flag", and the
//   flip is held off rather than reported as a false "no improvement".
//
// Spec: docs/superpowers/specs/2026-06-20-george-eval-harness-design.md
// Header last reviewed: 2026-06-19

import type {
  ABReport,
  AbsoluteDelta,
  AggregatedJudge,
  ArmAggregate,
  DimKey,
  FullReport,
  GateResult,
  JudgeScore,
  PairwiseJudgment,
  PairwiseTally,
  Scenario,
  ScenarioRow,
  TurnRecord,
} from './types.js';

export const DIM_KEYS: DimKey[] = [
  'registerFit',
  'restraint',
  'voiceFidelity',
  'groundedness',
  'helpfulness',
  'personaSafety',
  'taste',
];

// Default reward weights: emphasize the non-negotiables (voiceFidelity +
// groundedness). voiceFidelity here is already min(registerFit, restraint).
export const DEFAULT_REWARD_WEIGHTS: Record<DimKey, number> = {
  registerFit: 0, // folded into voiceFidelity via min(); not double-counted
  restraint: 0, // folded into voiceFidelity via min(); not double-counted
  voiceFidelity: 0.3,
  groundedness: 0.3,
  helpfulness: 0.15,
  personaSafety: 0.15,
  taste: 0.1,
};

// Flip-guard thresholds. The margin is the MINIMUM real effect; significance also
// requires the delta to clear the measured stdErr band so ~25 scenarios can't
// manufacture confidence (must-fix 4).
export interface FlipGuardConfig {
  // Minimum target-dimension improvement to even consider a flip.
  targetMargin: number;
  // Max allowed drop on voiceFidelity / groundedness (non-negotiables).
  voiceAntiFabEpsilon: number;
  // Pairwise sign-test alpha.
  alpha: number;
}

export const DEFAULT_FLIP_GUARD: FlipGuardConfig = {
  targetMargin: 0.3,
  voiceAntiFabEpsilon: 0.1,
  alpha: 0.05,
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// ── Per-(scenario, arm) judge aggregation (repeated sampling) ───────────────

// Aggregate k judge draws for one (scenario, arm). voiceFidelity per draw is
// min(registerFit, restraint) (already set on JudgeScore). reward is 0 when the
// gate failed (hard floor), else the weighted mean across draws.
export function aggregateJudgeDraws(
  scenarioId: string,
  flagConfigName: string,
  draws: JudgeScore[],
  gatePassed: boolean,
  weights: Record<DimKey, number> = DEFAULT_REWARD_WEIGHTS,
): AggregatedJudge {
  const byDim = (k: DimKey): number[] => draws.map((d) => d[k]);
  const meanScore = {
    registerFit: mean(byDim('registerFit')),
    restraint: mean(byDim('restraint')),
    voiceFidelity: mean(byDim('voiceFidelity')),
    groundedness: mean(byDim('groundedness')),
    helpfulness: mean(byDim('helpfulness')),
    personaSafety: mean(byDim('personaSafety')),
    taste: mean(byDim('taste')),
  };
  const sdScore = {
    registerFit: sd(byDim('registerFit')),
    restraint: sd(byDim('restraint')),
    voiceFidelity: sd(byDim('voiceFidelity')),
    groundedness: sd(byDim('groundedness')),
    helpfulness: sd(byDim('helpfulness')),
    personaSafety: sd(byDim('personaSafety')),
    taste: sd(byDim('taste')),
  };
  // Reward: 0 if gate failed; else weighted sum of dim means. voiceFidelity is
  // already min(registerFit, restraint) so the slop attractor is closed.
  let reward = 0;
  if (gatePassed) {
    for (const k of DIM_KEYS) reward += (weights[k] ?? 0) * meanScore[k];
  }
  return {
    scenarioId,
    flagConfigName,
    k: draws.length,
    mean: meanScore,
    sd: sdScore,
    reward,
    rationales: draws.map((d) => d.rationale),
    judgeModel: draws[0]?.judgeModel ?? 'unknown',
  };
}

// ── Arm aggregate (across scenarios) ────────────────────────────────────────

export function aggregateArm(
  flagConfigName: string,
  records: TurnRecord[],
  gateByScenario: Map<string, GateResult>,
  judgeByScenario: Map<string, AggregatedJudge>,
): ArmAggregate {
  const armRecords = records.filter((r) => r.flagConfigName === flagConfigName);
  const gatePasses = armRecords.filter((r) => gateByScenario.get(r.scenarioId)?.pass).length;
  const meanByDim = {} as Record<DimKey, number>;
  const sdByDim = {} as Record<DimKey, number>;
  for (const k of DIM_KEYS) {
    const vals: number[] = [];
    const sds: number[] = [];
    for (const r of armRecords) {
      const j = judgeByScenario.get(r.scenarioId);
      if (j) {
        vals.push(j.mean[k]);
        sds.push(j.sd[k]);
      }
    }
    meanByDim[k] = mean(vals);
    sdByDim[k] = mean(sds); // mean per-scenario SD = typical judge noise at this dim
  }
  const totalCostUsd = armRecords.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  return {
    flagConfigName,
    gatePassRate: armRecords.length ? gatePasses / armRecords.length : 0,
    meanByDim,
    sdByDim,
    totalCostUsd,
    judgeCalls: judgeByScenario.size,
    candidateTurns: armRecords.length,
  };
}

// ── Absolute per-dimension deltas with significance ─────────────────────────

// Pair OFF/ON per-scenario means and compute the delta, its stdErr across
// scenarios, and a significance flag (must-fix 4). A delta is significant only
// when it clears BOTH the configured margin AND its own stdErr band.
export function computeAbsoluteDeltas(
  scenarioIds: string[],
  judgeOff: Map<string, AggregatedJudge>,
  judgeOn: Map<string, AggregatedJudge>,
  guard: FlipGuardConfig = DEFAULT_FLIP_GUARD,
): AbsoluteDelta[] {
  return DIM_KEYS.map((dim) => {
    const offVals: number[] = [];
    const onVals: number[] = [];
    const perScenarioDeltas: number[] = [];
    for (const id of scenarioIds) {
      const o = judgeOff.get(id);
      const n = judgeOn.get(id);
      if (o && n) {
        offVals.push(o.mean[dim]);
        onVals.push(n.mean[dim]);
        perScenarioDeltas.push(n.mean[dim] - o.mean[dim]);
      }
    }
    const offMean = mean(offVals);
    const onMean = mean(onVals);
    const delta = onMean - offMean;
    const pooledSd = sd(perScenarioDeltas);
    const stdErr = perScenarioDeltas.length > 0 ? pooledSd / Math.sqrt(perScenarioDeltas.length) : 0;
    // Significant: clears the configured margin AND exceeds its noise band
    // (|delta| > stdErr). The margin per dim defaults to targetMargin; the
    // non-negotiables use the tighter epsilon as their "real drop" threshold.
    const margin =
      dim === 'voiceFidelity' || dim === 'groundedness' ? guard.voiceAntiFabEpsilon : guard.targetMargin;
    const significant = Math.abs(delta) >= margin && Math.abs(delta) > stdErr;
    return { dim, off: offMean, on: onMean, delta, pooledSd, stdErr, significant };
  });
}

// ── Pairwise tally + sign test ──────────────────────────────────────────────

// Two-sided exact binomial sign-test p-value for k successes out of n trials at
// p=0.5 (ties excluded by the caller). Small-n exact so a 1-3 scenario "record"
// is correctly reported as non-significant (must-fix 4).
export function signTestP(onWins: number, onLosses: number): number {
  const n = onWins + onLosses;
  if (n === 0) return 1;
  const k = Math.min(onWins, onLosses);
  // P(X <= k) + P(X >= n-k) under Binom(n, 0.5), then *clamp at 1 for two-sided.
  let cum = 0;
  for (let i = 0; i <= k; i++) cum += binomPmf(n, i, 0.5);
  const p = Math.min(1, 2 * cum);
  return p;
}

function binomPmf(n: number, k: number, p: number): number {
  return logChooseExp(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

function logChooseExp(n: number, k: number): number {
  // n choose k via lgamma to stay stable for the small n here.
  return Math.exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1));
}

// Lanczos lgamma — adequate precision for the small n in this harness.
function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Tally a set of pairwise judgments (each already mapped to OFF/ON, not A/B).
export function tallyPairwise(judgments: Array<{ onWon: boolean | null }>): PairwiseTally {
  let onWins = 0;
  let ties = 0;
  let onLosses = 0;
  for (const j of judgments) {
    if (j.onWon === null) ties++;
    else if (j.onWon) onWins++;
    else onLosses++;
  }
  return { onWins, ties, onLosses, n: judgments.length, signTestP: signTestP(onWins, onLosses) };
}

// ── Flip decision ───────────────────────────────────────────────────────────

export interface FlipInputs {
  flag: string;
  pathFlagsPinned: Record<string, string>;
  judgeModel: string;
  split: 'train' | 'selection' | 'test' | 'all';
  gatePassRateOff: number;
  gatePassRateOn: number;
  absoluteDeltas: AbsoluteDelta[];
  pairwiseFull: PairwiseTally;
  pairwiseFlagTarget: PairwiseTally;
  noReplyMetric?: ABReport['noReplyMetric'];
  flagActivation?: ABReport['flagActivation'];
  // Which dimension(s) the flag targets (for the "target improves" guard).
  targetDims: DimKey[];
  errorArms: number;
  guard?: FlipGuardConfig;
}

// Decide flip-on vs hold-off and return the single deciding guard. Order of
// vetoes (any one holds the flip): gate regression, voice/anti-fab regression,
// then the positive requirements (target improves AND pairwise/NOREPLY confirms).
export function decideFlip(inp: FlipInputs): { recommendation: 'flip-on' | 'hold-off'; decidingGuard: string } {
  const guard = inp.guard ?? DEFAULT_FLIP_GUARD;

  // VETO 0: any error arm makes the comparison untrustworthy.
  if (inp.errorArms > 0) {
    return { recommendation: 'hold-off', decidingGuard: `${inp.errorArms} error arm(s) — comparison untrustworthy` };
  }

  // VETO 1 (non-negotiable): gate-pass-rate must not regress.
  if (inp.gatePassRateOn < inp.gatePassRateOff) {
    return {
      recommendation: 'hold-off',
      decidingGuard: `gate-pass regressed (ON ${inp.gatePassRateOn.toFixed(2)} < OFF ${inp.gatePassRateOff.toFixed(2)})`,
    };
  }

  // VETO 2: voiceFidelity / groundedness must not drop past epsilon, AND the
  // drop must be a REAL effect (significant), not noise.
  for (const dim of ['voiceFidelity', 'groundedness'] as DimKey[]) {
    const d = inp.absoluteDeltas.find((x) => x.dim === dim);
    if (d && d.delta < -guard.voiceAntiFabEpsilon && d.significant) {
      return {
        recommendation: 'hold-off',
        decidingGuard: `${dim} regressed (Δ ${d.delta.toFixed(2)}, significant) past epsilon ${guard.voiceAntiFabEpsilon}`,
      };
    }
  }

  // NO_REPLY-class flags: decide by the assertion metric, NOT pairwise (must-fix
  // 2). Require ON to suppress correctly AND OFF to reply correctly on the
  // pure-ack scenarios.
  if (inp.noReplyMetric) {
    const m = inp.noReplyMetric;
    const onOk = m.onTotal > 0 && m.onCorrectSuppressions === m.onTotal;
    const offOk = m.offTotal > 0 && m.offCorrectReplies === m.offTotal;
    if (onOk && offOk) {
      return {
        recommendation: 'flip-on',
        decidingGuard: `NO_REPLY assertion passed (ON ${m.onCorrectSuppressions}/${m.onTotal} suppressed, OFF ${m.offCorrectReplies}/${m.offTotal} replied) with no voice/anti-fab/gate regression`,
      };
    }
    return {
      recommendation: 'hold-off',
      decidingGuard: `NO_REPLY assertion failed (ON ${m.onCorrectSuppressions}/${m.onTotal}, OFF ${m.offCorrectReplies}/${m.offTotal})`,
    };
  }

  // VETO 3 (must-fix 7): for a flag-target A/B, the ON path must have actually
  // activated on the flag-target scenarios. A null delta with no activation is
  // "scenario never tripped the flag", not "no improvement".
  if (inp.flagActivation && inp.flagActivation.total > 0 && inp.flagActivation.activated === 0) {
    return {
      recommendation: 'hold-off',
      decidingGuard: `flag never activated on any flag-target ON arm (0/${inp.flagActivation.total}) — A/B is a false null`,
    };
  }

  // POSITIVE: the target dimension must improve by a meaningful, significant margin.
  let targetImproved = false;
  for (const dim of inp.targetDims) {
    const d = inp.absoluteDeltas.find((x) => x.dim === dim);
    if (d && d.delta >= guard.targetMargin && d.significant) targetImproved = true;
  }
  if (!targetImproved) {
    return {
      recommendation: 'hold-off',
      decidingGuard: `no target dimension (${inp.targetDims.join(', ')}) improved by a significant ${guard.targetMargin}`,
    };
  }

  // POSITIVE: pairwise ON-wins must clearly exceed losses on the flag-target
  // subset AND clear the sign-test (must-fix 4 — not 1-3 coin flips).
  const pw = inp.pairwiseFlagTarget;
  const pairwiseConfirms = pw.onWins > pw.onLosses && pw.signTestP <= guard.alpha;
  if (!pairwiseConfirms) {
    return {
      recommendation: 'hold-off',
      decidingGuard: `pairwise on flag-target not significant (ON ${pw.onWins}-${pw.onLosses}, sign-test p=${pw.signTestP.toFixed(3)} > ${guard.alpha})`,
    };
  }

  return {
    recommendation: 'flip-on',
    decidingGuard: `target improved (Δ>=${guard.targetMargin}, significant) AND pairwise ON-wins significant (${pw.onWins}-${pw.onLosses}, p=${pw.signTestP.toFixed(3)}) with no gate/voice/anti-fab regression`,
  };
}

// ── Top-level report assembly ───────────────────────────────────────────────

export interface AggregateInputs {
  flag: string;
  pathFlagsPinned: Record<string, string>;
  judgeModel: string;
  split: 'train' | 'selection' | 'test' | 'all';
  scenarios: Scenario[];
  records: TurnRecord[]; // both arms
  gateByArm: Map<string, Map<string, GateResult>>; // armName -> scenarioId -> gate
  judgeByArm: Map<string, Map<string, AggregatedJudge>>; // armName -> scenarioId -> judge
  pairwiseFullJudgments: Array<{ onWon: boolean | null }>;
  pairwiseFlagTargetJudgments: Array<{ onWon: boolean | null }>;
  noReplyMetric?: ABReport['noReplyMetric'];
  flagActivation?: ABReport['flagActivation'];
  targetDims: DimKey[];
  offArm: string;
  onArm: string;
  guard?: FlipGuardConfig;
}

export function buildReport(inp: AggregateInputs): FullReport {
  const guard = inp.guard ?? DEFAULT_FLIP_GUARD;
  const gateOff = inp.gateByArm.get(inp.offArm) ?? new Map();
  const gateOn = inp.gateByArm.get(inp.onArm) ?? new Map();
  const judgeOff = inp.judgeByArm.get(inp.offArm) ?? new Map();
  const judgeOn = inp.judgeByArm.get(inp.onArm) ?? new Map();

  const armOff = aggregateArm(inp.offArm, inp.records, gateOff, judgeOff);
  const armOn = aggregateArm(inp.onArm, inp.records, gateOn, judgeOn);

  const scenarioIds = inp.scenarios.map((s) => s.id);
  const absoluteDeltas = computeAbsoluteDeltas(scenarioIds, judgeOff, judgeOn, guard);
  const pairwiseFull = tallyPairwise(inp.pairwiseFullJudgments);
  const pairwiseFlagTarget = tallyPairwise(inp.pairwiseFlagTargetJudgments);
  const errorArms = inp.records.filter((r) => r.error).length;

  const flip = decideFlip({
    flag: inp.flag,
    pathFlagsPinned: inp.pathFlagsPinned,
    judgeModel: inp.judgeModel,
    split: inp.split,
    gatePassRateOff: armOff.gatePassRate,
    gatePassRateOn: armOn.gatePassRate,
    absoluteDeltas,
    pairwiseFull,
    pairwiseFlagTarget,
    noReplyMetric: inp.noReplyMetric,
    flagActivation: inp.flagActivation,
    targetDims: inp.targetDims,
    errorArms,
    guard,
  });

  const ab: ABReport = {
    flag: inp.flag,
    pathFlagsPinned: inp.pathFlagsPinned,
    judgeModel: inp.judgeModel,
    split: inp.split,
    gatePassRateOff: armOff.gatePassRate,
    gatePassRateOn: armOn.gatePassRate,
    gatePassRateDelta: armOn.gatePassRate - armOff.gatePassRate,
    absoluteDeltas,
    pairwiseFull,
    pairwiseFlagTarget,
    noReplyMetric: inp.noReplyMetric,
    flagActivation: inp.flagActivation,
    flipRecommendation: flip.recommendation,
    decidingGuard: flip.decidingGuard,
    errorArms,
  };

  const scenarioRows: ScenarioRow[] = [];
  for (const arm of [inp.offArm, inp.onArm]) {
    const gate = inp.gateByArm.get(arm) ?? new Map();
    const judge = inp.judgeByArm.get(arm) ?? new Map();
    for (const s of inp.scenarios) {
      const rec = inp.records.find((r) => r.scenarioId === s.id && r.flagConfigName === arm);
      if (!rec) continue;
      const g = gate.get(s.id);
      const j = judge.get(s.id);
      const dims = j
        ? (Object.fromEntries(DIM_KEYS.map((k) => [k, j.mean[k]])) as Record<DimKey, number>)
        : undefined;
      scenarioRows.push({
        id: s.id,
        category: s.category,
        flagArm: arm,
        split: s.split,
        gatePass: g?.pass ?? false,
        gateFailures: g?.failures ?? [],
        reply: rec.reply,
        suppressed: rec.suppressed,
        tools: rec.tools,
        costUsd: rec.costUsd,
        fastPath: rec.fastPath,
        flagActivated: rec.flagActivated,
        dims,
        reward: j?.reward,
        rationale: j?.rationales[0],
      });
    }
  }

  const candidateCalls = inp.records.filter((r) => !r.error).length;
  const judgeCalls = armOff.judgeCalls + armOn.judgeCalls;
  const totalUsd = inp.records.reduce((a, r) => a + (r.costUsd ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    judgeModel: inp.judgeModel,
    flag: inp.flag,
    scenarioRows,
    armAggregates: [armOff, armOn],
    ab,
    cost: { candidateCalls, judgeCalls, totalUsd },
  };
}

// ── Markdown one-pager ──────────────────────────────────────────────────────

export function renderMarkdown(report: FullReport): string {
  const ab = report.ab;
  const lines: string[] = [];
  lines.push(`# george eval — flag A/B: ${ab.flag}`);
  lines.push('');
  lines.push(`**FLIP RECOMMENDATION: ${ab.flipRecommendation.toUpperCase()}**`);
  lines.push('');
  lines.push(`> ${ab.decidingGuard}`);
  lines.push('');
  lines.push(`- judge model: \`${report.judgeModel}\``);
  lines.push(`- split: ${ab.split}`);
  lines.push(`- path flags pinned: ${JSON.stringify(ab.pathFlagsPinned)}`);
  lines.push(`- gate pass rate: OFF ${ab.gatePassRateOff.toFixed(2)} -> ON ${ab.gatePassRateOn.toFixed(2)} (Δ ${ab.gatePassRateDelta.toFixed(2)})`);
  if (ab.errorArms > 0) lines.push(`- ⚠️ error arms: ${ab.errorArms}`);
  lines.push('');
  lines.push('## OFF vs ON dimension table');
  lines.push('');
  lines.push('| dim | OFF | ON | Δ | stdErr | significant |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const d of ab.absoluteDeltas) {
    lines.push(
      `| ${d.dim} | ${d.off.toFixed(2)} | ${d.on.toFixed(2)} | ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(2)} | ${d.stdErr.toFixed(3)} | ${d.significant ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push('## Pairwise (NO_REPLY-class excluded)');
  lines.push(`- full set: ON ${ab.pairwiseFull.onWins}W / ${ab.pairwiseFull.ties}T / ${ab.pairwiseFull.onLosses}L (sign-test p=${ab.pairwiseFull.signTestP.toFixed(3)})`);
  lines.push(`- flag-target subset: ON ${ab.pairwiseFlagTarget.onWins}W / ${ab.pairwiseFlagTarget.ties}T / ${ab.pairwiseFlagTarget.onLosses}L (sign-test p=${ab.pairwiseFlagTarget.signTestP.toFixed(3)})`);
  if (ab.noReplyMetric) {
    lines.push('');
    lines.push('## NO_REPLY assertion metric (replaces pairwise here)');
    lines.push(`- ON correct suppressions: ${ab.noReplyMetric.onCorrectSuppressions}/${ab.noReplyMetric.onTotal}`);
    lines.push(`- OFF correct replies: ${ab.noReplyMetric.offCorrectReplies}/${ab.noReplyMetric.offTotal}`);
  }
  if (ab.flagActivation) {
    lines.push('');
    lines.push(`## Flag activation (ON arm, flag-target scenarios): ${ab.flagActivation.activated}/${ab.flagActivation.total}`);
  }

  // Worst 3 gate failures + worst 3 judged scenarios.
  const failed = report.scenarioRows.filter((r) => !r.gatePass).slice(0, 3);
  if (failed.length) {
    lines.push('');
    lines.push('## Worst gate failures');
    for (const r of failed) {
      lines.push(`- [${r.flagArm}] ${r.id} (${r.category}): ${r.gateFailures.map((f) => f.rule).join(', ')}`);
    }
  }
  const judged = report.scenarioRows
    .filter((r) => r.reward !== undefined)
    .sort((a, b) => (a.reward ?? 0) - (b.reward ?? 0))
    .slice(0, 3);
  if (judged.length) {
    lines.push('');
    lines.push('## Worst judged scenarios');
    for (const r of judged) {
      lines.push(`- [${r.flagArm}] ${r.id} reward=${(r.reward ?? 0).toFixed(2)}: ${r.rationale ?? ''}`);
    }
  }
  lines.push('');
  lines.push(`## Cost: ${report.cost.candidateCalls} candidate turns, ${report.cost.judgeCalls} judge calls, $${report.cost.totalUsd.toFixed(4)}`);
  lines.push('');
  return lines.join('\n');
}
