// tests/eval/sim-users/sim-users.test.ts
//
// SimAB harness entry (persona-conditioned simulated users, arXiv 2603.01024):
// each frozen persona converses multi-turn with the REAL george under two arms
// (OFF = 3-agent dispatch, ON = SINGLE_AGENT), same persona seed, deterministic
// counterbalancing, Opus transcript-level pairwise judge + per-arm goal
// completion (the concierge handled-rate). Complements — does not replace — the
// scripted scenario harness: that one owns adversarial probes and regression
// tripwires; this one owns everything that only emerges over a real
// conversation (register drift at turn 5, bridge-on-signal, length matching
// under impatience, memory across turns).
//
// Gating (real run costs real money and ~30-45 min):
//   GEORGE_EVAL_SIMUSERS_ENABLED=true GEORGE_EVAL_JUDGE_ENABLED=true \
//     ANTHROPIC_API_KEY=... npx vitest run tests/eval/sim-users
//   GEORGE_EVAL_SIM_PERSONA_N caps the panel (default 6 of 10).
//
// Conversations run SEQUENTIALLY — the arena mutates process.env per arm, so
// parallel conversations would clobber each other's flags.
//
// Header last reviewed: 2026-07-01

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runArmBatch, runSimConversation, type SimTranscript } from './arena.js';
import { judgeTranscripts, type SimJudgment } from './judge-sim.js';
import type { Persona } from './simulator.js';
import type { FlagConfig } from '../conversation/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.out');

const REAL_ENABLED = process.env.GEORGE_EVAL_SIMUSERS_ENABLED === 'true';
const JUDGE_ENABLED = process.env.GEORGE_EVAL_JUDGE_ENABLED === 'true';
const PERSONA_N = Math.max(1, parseInt(process.env.GEORGE_EVAL_SIM_PERSONA_N || '6', 10));
// Panel selection: 'curated' = the 10 hand-built diagnostic archetypes;
// 'generated' = the N-ordinary-students statistical panel (generate-personas.ts).
const PANEL = process.env.GEORGE_EVAL_SIM_PANEL === 'generated' ? 'generated' : 'curated';
// Same-arm conversation concurrency (env is constant within an arm; arms run
// sequentially). Judge calls use the same bound.
const CONCURRENCY = Math.max(1, parseInt(process.env.GEORGE_EVAL_SIM_CONCURRENCY || '4', 10));

function loadPersonas(): Persona[] {
  if (PANEL === 'generated') {
    const f = path.join(__dirname, 'fixtures/generated-personas.json');
    if (!existsSync(f)) {
      throw new Error('generated panel missing — run: npx tsx tests/eval/sim-users/generate-personas.ts');
    }
    return (JSON.parse(readFileSync(f, 'utf-8')) as { personas: Persona[] }).personas;
  }
  const raw = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/personas.json'), 'utf-8')) as {
    personas: Persona[];
  };
  return raw.personas;
}

// Bounded-concurrency map that preserves input order.
async function pmap<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The two arms of the architecture A/B. Fast path pinned OFF on BOTH arms so
// the topology is the only variable (same rationale as the scripted harness's
// path-flag rule); trunk pinned OFF; the flag under test is SINGLE_AGENT.
const ARM_OFF: FlagConfig = {
  name: 'OFF',
  flags: { SINGLE_AGENT: 'false', GEORGE_TRUNK_HYBRID: 'false', GEORGE_DISABLE_FAST_PATH: 'true' },
};
const ARM_ON: FlagConfig = {
  name: 'ON',
  flags: { SINGLE_AGENT: 'true', GEORGE_TRUNK_HYBRID: 'false', GEORGE_DISABLE_FAST_PATH: 'true' },
};

interface PersonaResult {
  personaId: string;
  off: SimTranscript;
  on: SimTranscript;
  judgment?: SimJudgment & { onWasA: boolean };
}

// Two-sided sign test (ties excluded), exact binomial.
function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.max(wins, losses);
  let tail = 0;
  for (let i = k; i <= n; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    tail += c * Math.pow(0.5, n);
  }
  return Math.min(1, 2 * tail);
}

describe.skipIf(!REAL_ENABLED)('sim-users: SINGLE_AGENT architecture A/B with simulated users', () => {
  it(
    'runs the persona panel over both arms, judges transcripts, writes a report',
    async () => {
      const panel = loadPersonas().slice(0, PERSONA_N);

      // Arms run sequentially (their env differs); conversations WITHIN an arm run
      // with bounded concurrency (env identical), which is what makes the
      // 100-persona statistical panel tractable.
      const offs = await runArmBatch(panel, ARM_OFF, { concurrency: CONCURRENCY });
      const ons = await runArmBatch(panel, ARM_ON, { concurrency: CONCURRENCY });
      const results: PersonaResult[] = panel.map((p, i) => ({
        personaId: p.id,
        off: offs[i],
        on: ons[i],
      }));

      if (JUDGE_ENABLED) {
        await pmap(results, Math.min(CONCURRENCY, 3), async (result, idx) => {
          if (result.off.turns.length === 0 || result.on.turns.length === 0) return;
          // Deterministic counterbalance: even panel index shows OFF as A.
          const onWasA = idx % 2 === 1;
          const [a, b] = onWasA ? [result.on, result.off] : [result.off, result.on];
          try {
            result.judgment = { ...(await judgeTranscripts(panel[idx], a, b)), onWasA };
          } catch {
            // judge failure recorded as missing judgment, never fails the suite
          }
        });
      }

      // ── Aggregate ──
      let onWins = 0;
      let offWins = 0;
      let ties = 0;
      let goalOnDone = 0;
      let goalOffDone = 0;
      let fabOn = 0;
      let fabOff = 0;
      let judged = 0;
      for (const r of results) {
        const j = r.judgment;
        if (!j) continue;
        judged++;
        const onLabel = j.onWasA ? 'A' : 'B';
        if (j.winner === 'tie') ties++;
        else if (j.winner === onLabel) onWins++;
        else offWins++;
        if ((j.onWasA ? j.goalCompletedA : j.goalCompletedB) === true) goalOnDone++;
        if ((j.onWasA ? j.goalCompletedB : j.goalCompletedA) === true) goalOffDone++;
        if ((j.onWasA ? j.fabricationA : j.fabricationB) === true) fabOn++;
        if ((j.onWasA ? j.fabricationB : j.fabricationA) === true) fabOff++;
      }
      const mean = (xs: (number | undefined)[]): number | undefined => {
        const ys = xs.filter((x): x is number => typeof x === 'number');
        return ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : undefined;
      };
      const report = {
        generatedAt: new Date().toISOString(),
        flag: 'SINGLE_AGENT',
        harness: 'sim-users (SimAB persona-conditioned agents)',
        personas: results.map((r) => ({
          id: r.personaId,
          offTurns: r.off.turns.length,
          onTurns: r.on.turns.length,
          offStopped: r.off.stopped,
          onStopped: r.on.stopped,
          offGateLiteFailures: r.off.gateLiteFailureCount,
          onGateLiteFailures: r.on.gateLiteFailureCount,
          offMeanMs: r.off.meanGeorgeMs,
          onMeanMs: r.on.meanGeorgeMs,
          winner: r.judgment
            ? r.judgment.winner === 'tie'
              ? 'tie'
              : (r.judgment.onWasA ? 'A' : 'B') === r.judgment.winner
                ? 'ON'
                : 'OFF'
            : 'unjudged',
          rationale: r.judgment?.rationale,
        })),
        panel: PANEL,
        tally: { onWins, offWins, ties, judged, signTestP: signTestP(onWins, offWins) },
        handledRate: {
          off: judged ? goalOffDone / judged : null,
          on: judged ? goalOnDone / judged : null,
        },
        // Fabrication incidents per judged conversation (george's #1 law). The
        // 2026-07-01 first run caught invented clubs/prices/actions on BOTH arms.
        fabricationRate: {
          off: judged ? fabOff / judged : null,
          on: judged ? fabOn / judged : null,
        },
        gateLite: {
          offTotal: results.reduce((n, r) => n + r.off.gateLiteFailureCount, 0),
          onTotal: results.reduce((n, r) => n + r.on.gateLiteFailureCount, 0),
        },
        latency: {
          offMeanMs: mean(results.map((r) => r.off.meanGeorgeMs)),
          onMeanMs: mean(results.map((r) => r.on.meanGeorgeMs)),
        },
        errors: results
          .filter((r) => r.off.stopped === 'error' || r.on.stopped === 'error')
          .map((r) => ({ id: r.personaId, off: r.off.error, on: r.on.error })),
        transcripts: results.map((r) => ({ off: r.off, on: r.on })),
      };

      mkdirSync(OUT_DIR, { recursive: true });
      const stamp = report.generatedAt.replace(/[:.]/g, '-');
      writeFileSync(path.join(OUT_DIR, `sim-report-${stamp}.json`), JSON.stringify(report, null, 2));
      const md = [
        `# sim-users report — SINGLE_AGENT A/B (${report.generatedAt})`,
        '',
        `panel: ${PANEL}, personas run: ${results.length}, judged: ${judged}`,
        `pairwise (transcript-level): ON wins ${onWins}, OFF wins ${offWins}, ties ${ties} (sign-test p=${report.tally.signTestP.toFixed(3)})`,
        `handled rate (goal completion): OFF ${report.handledRate.off ?? 'n/a'} -> ON ${report.handledRate.on ?? 'n/a'}`,
        `fabrication rate: OFF ${report.fabricationRate.off ?? 'n/a'} -> ON ${report.fabricationRate.on ?? 'n/a'}`,
        `gate-lite failures: OFF ${report.gateLite.offTotal} -> ON ${report.gateLite.onTotal}`,
        `mean george latency: OFF ${report.latency.offMeanMs ?? '?'}ms -> ON ${report.latency.onMeanMs ?? '?'}ms`,
        '',
        ...report.personas.map(
          (p) =>
            `- ${p.id}: winner=${p.winner}, turns ${p.offTurns}/${p.onTurns}, gateLite ${p.offGateLiteFailures}/${p.onGateLiteFailures}, ms ${p.offMeanMs ?? '?'}/${p.onMeanMs ?? '?'}${p.rationale ? ` — ${p.rationale}` : ''}`,
        ),
      ].join('\n');
      writeFileSync(path.join(OUT_DIR, `sim-report-${stamp}.md`), md);

      // Hard assertions kept minimal (v1): the harness must produce usable data.
      expect(results.length).toBeGreaterThan(0);
      const usable = results.filter((r) => r.off.turns.length > 0 && r.on.turns.length > 0);
      expect(usable.length).toBeGreaterThan(0);
    },
    3_600_000,
  );
});

// Free plumbing smoke: one persona, one mock turn per arm, zero network. Always runs.
describe('sim-users plumbing (mock)', () => {
  it('runs a 1-turn mock conversation on both arms and captures the seeded opener', async () => {
    const persona: Persona = {
      ...loadPersonas()[0],
      maxTurns: 1, // opener only — turn 2 would invoke the simulator LLM
    };
    for (const arm of [ARM_OFF, ARM_ON]) {
      const t = await runSimConversation(persona, arm, { mockMode: true });
      expect(t.turns).toHaveLength(1);
      expect(t.turns[0].user).toBe(persona.opener);
      expect(t.stopped).not.toBe('error');
    }
  }, 30_000);
});
