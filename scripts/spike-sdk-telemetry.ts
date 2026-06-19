// scripts/spike-sdk-telemetry.ts
//
// SDK TELEMETRY SPIKE — the "一下午 spike" from
// docs/superpowers/notes/2026-06-17-dashboard-analytics-model-adaptation-thinking.md (§8).
//
// PURPOSE: this is the ZERO-migration, ZERO-DB-write probe that gates the entire
// Phase-0 telemetry effort. It dumps the RAW SDK message stream of a real george
// turn and auto-answers the 5 questions that drive every downstream effort estimate:
//
//   Q1  Does the `result` message carry usage.input_tokens / output_tokens?
//   Q2  Does it carry total_cost_usd + modelUsage (per-model token/cost), as the
//       v0.3.168 SDK types claim (sdk.d.ts: SDKResultSuccess / ModelUsage)?
//   Q3  Do the ERROR / ABORT branches still carry cost/usage? (the highest-value
//       turns to capture: max-turns blowups, budget kills, superseded turns)
//   Q4  Are the sub-agent's tool_use + tool_result blocks (and the sub-agent name
//       marker) visible in the stream? (gates anti-fabrication + routing-accuracy)
//   Q5  Does query({ model }) actually swap the model the SDK runs on?
//
// SAFETY:
//   - NO DB writes. Runs runOrchestrator with channel:'web' and NO session/profile
//     store, so it never calls resolveStudentId, never loads a profile, never saves
//     a message. (It still constructs the Supabase client at import — no query runs.)
//   - Makes a few REAL LLM calls (a know-things turn + a forced-error turn + two tiny
//     model-swap probes). Cost: a few US cents total on Claude.
//   - Forces the Claude model path by default so the cost/modelUsage fields are
//     populated (local .env may point GEORGE_MODEL_* at DeepSeek, which would not
//     exercise the Claude cost accounting). Pass --keep-env to use whatever .env says.
//
// USAGE (from repo root):
//   pnpm tsx scripts/spike-sdk-telemetry.ts                 # all probes + summary
//   pnpm tsx scripts/spike-sdk-telemetry.ts --verbose       # + full JSON per message
//   pnpm tsx scripts/spike-sdk-telemetry.ts --prompt "..."  # custom know-things turn
//   pnpm tsx scripts/spike-sdk-telemetry.ts --keep-env      # don't force Claude models
//   pnpm tsx scripts/spike-sdk-telemetry.ts --no-error --no-swap   # skip probes
//   npm run spike:sdk
//
// Header last reviewed: 2026-06-17

import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const VERBOSE = flag('verbose');
const KEEP_ENV = flag('keep-env');
const RUN_ERROR = !flag('no-error');
const RUN_SWAP = !flag('no-swap');
const RUN_MAIN = !flag('no-main');

// Models used to force the Claude path (Q2/Q5 need real Claude cost accounting).
const FORCE_FAST = opt('model', 'claude-haiku-4-5-20251001'); // orchestrator + FAST sub-agents
const FORCE_SMART = opt('smart-model', 'claude-sonnet-4-6'); // know-things sub-agent
const SWAP_A = opt('swap-a', 'claude-haiku-4-5-20251001');
const SWAP_B = opt('swap-b', 'claude-sonnet-4-6');

// Default turn: a know-things, tool-firing prompt (writ150 → rmp playbook).
const PROMPT = opt('prompt', '学长，writ 150 哪个教授值得选？想要 rmp 高的');

// ── Observations the final summary is computed from.
const obs = {
  usageTokens: false, // Q1
  costAndModelUsage: false, // Q2
  errorBranchCost: null as null | boolean, // Q3
  sawSubAgentDispatch: false, // Q4
  sawToolResult: false, // Q4
  swapDistinct: null as null | boolean, // Q5
  swapModels: [] as string[],
  mainModelUsageKeys: [] as string[],
};

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────
function banner(title: string) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + title);
  console.log('═'.repeat(72));
}

function num(v: unknown): string {
  return typeof v === 'number' ? String(v) : '∅';
}

// One-line classification of a raw SDK message + side-effect observation capture.
function describeMessage(message: unknown, idx: number): void {
  const m = message as any;
  const t = m?.type ?? 'unknown';

  if (t === 'system') {
    console.log(
      `  [${idx}] system/${m.subtype ?? '?'}  model=${m.model ?? '?'}  tools=${
        Array.isArray(m.tools) ? m.tools.length : '?'
      }  agents=${m.agents ? Object.keys(m.agents).length : (Array.isArray(m.agents) ? m.agents.length : '?')}`,
    );
  } else if (t === 'assistant') {
    const content = m.message?.content ?? [];
    const model = m.message?.model ?? '?';
    for (const c of content) {
      if (c.type === 'text') {
        const preview = String(c.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
        console.log(`  [${idx}] assistant/text  model=${model}  "${preview}"`);
      } else if (c.type === 'tool_use') {
        const name = c.name ?? '?';
        const isDispatch = name === 'Task' || name === 'Agent';
        const sub = c.input?.subagent_type ?? c.input?.subagentType ?? c.input?.description;
        if (isDispatch) {
          obs.sawSubAgentDispatch = true;
          console.log(
            `  [${idx}] assistant/DISPATCH → ${name}(subagent=${sub ?? '?'})  model=${model}`,
          );
        } else {
          console.log(`  [${idx}] assistant/tool_use  ${name}  model=${model}`);
        }
      } else {
        console.log(`  [${idx}] assistant/${c.type}  model=${model}`);
      }
    }
    if (content.length === 0) console.log(`  [${idx}] assistant/(empty)  model=${model}`);
  } else if (t === 'user') {
    const content = m.message?.content ?? [];
    for (const c of content) {
      if (c.type === 'tool_result') {
        obs.sawToolResult = true;
        const payload = Array.isArray(c.content)
          ? c.content.map((p: any) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(' ')
          : String(c.content ?? '');
        const preview = payload.replace(/\s+/g, ' ').slice(0, 80);
        console.log(
          `  [${idx}] user/tool_result  for=${String(c.tool_use_id ?? '?').slice(0, 12)}  isError=${
            c.is_error ?? false
          }  "${preview}"`,
        );
      } else {
        console.log(`  [${idx}] user/${c.type}`);
      }
    }
  } else if (t === 'result') {
    // Telemetry — the payload Phase 0 wants. Works for BOTH success and error subtypes.
    const r = m as any;
    console.log(`  [${idx}] RESULT  subtype=${r.subtype}  is_error=${r.is_error}`);
    console.log(`        num_turns=${r.num_turns}  stop_reason=${r.stop_reason ?? '∅'}`);
    console.log(`        duration_ms=${num(r.duration_ms)}  duration_api_ms=${num(r.duration_api_ms)}  ttft_ms=${num(r.ttft_ms)}`);
    console.log(`        total_cost_usd=${num(r.total_cost_usd)}`);
    const u = r.usage ?? {};
    console.log(
      `        usage: input=${num(u.input_tokens)} output=${num(u.output_tokens)} ` +
        `cacheRead=${num(u.cache_read_input_tokens)} cacheCreate=${num(u.cache_creation_input_tokens)}`,
    );
    const mu = (r.modelUsage ?? {}) as Record<string, any>;
    const keys = Object.keys(mu);
    console.log(`        modelUsage keys (= models that actually ran): ${keys.join(', ') || '∅'}`);
    for (const k of keys) {
      const v = mu[k];
      console.log(
        `          • ${k}: in=${num(v.inputTokens)} out=${num(v.outputTokens)} ` +
          `cacheRead=${num(v.cacheReadInputTokens)} webSearch=${num(v.webSearchRequests)} costUSD=${num(v.costUSD)}`,
      );
    }
    if (Array.isArray(r.errors) && r.errors.length) console.log(`        errors: ${r.errors.join(' | ')}`);

    // capture observations
    if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') obs.usageTokens = true;
    if (typeof r.total_cost_usd === 'number' && keys.length > 0) obs.costAndModelUsage = true;

    return; // result printed in full; don't also dump verbose
  } else {
    console.log(`  [${idx}] ${t}`);
  }

  if (VERBOSE) console.log('       ' + JSON.stringify(message));
}

// Pull the result message out of a stream (success or error).
function isResult(m: any): boolean {
  return m?.type === 'result';
}

// ──────────────────────────────────────────────────────────────────────────
// PROBE A — full-stack stream dump via the REAL orchestrator path
// ──────────────────────────────────────────────────────────────────────────
async function probeMain(runOrchestrator: any, label: string, maxTurns?: number) {
  banner(`PROBE A${maxTurns ? ' (forced error: maxTurns=' + maxTurns + ')' : ''} — ${label}`);
  console.log(`  prompt: "${PROMPT}"`);
  console.log(`  orchestrator/FAST model=${process.env.GEORGE_MODEL_FAST}  SMART model=${process.env.GEORGE_MODEL_SMART}`);
  console.log('  ── raw SDK message stream ──');

  let idx = 0;
  let lastResult: any = null;
  try {
    for await (const message of runOrchestrator({
      userId: `spike-${maxTurns ? 'err' : 'main'}`,
      channel: 'web', // avoids resolveStudentId (imessage-only) → zero DB
      text: PROMPT,
      maxTurns,
    })) {
      describeMessage(message, idx++);
      if (isResult(message)) lastResult = message;
    }
  } catch (err) {
    console.error('  ✖ probe threw:', (err as Error).message);
  }

  if (maxTurns && lastResult) {
    // Q3: did the error-subtype result still carry cost + usage?
    const carriesCost =
      typeof lastResult.total_cost_usd === 'number' &&
      Object.keys(lastResult.modelUsage ?? {}).length > 0 &&
      typeof lastResult.usage?.input_tokens === 'number';
    obs.errorBranchCost = carriesCost;
    console.log(
      `  → Q3 check: error-branch result is_error=${lastResult.is_error} subtype=${lastResult.subtype} ` +
        `carriesCost=${carriesCost}`,
    );
  } else if (lastResult) {
    obs.mainModelUsageKeys = Object.keys(lastResult.modelUsage ?? {});
  }
}

// ──────────────────────────────────────────────────────────────────────────
// PROBE B — direct SDK model-swap probe (isolates Q5 from george's stack)
// ──────────────────────────────────────────────────────────────────────────
async function probeModelSwap(model: string): Promise<string[]> {
  let lastResult: any = null;
  for await (const message of query({
    prompt: 'Reply with exactly the word: OK',
    options: {
      model,
      maxTurns: 1,
      settingSources: [], // isolate from host ~/.claude config, like the orchestrator
      persistSession: false,
    },
  })) {
    if (isResult(message)) lastResult = message;
  }
  const keys = Object.keys(lastResult?.modelUsage ?? {});
  console.log(
    `  requested model=${model}  →  modelUsage keys=${keys.join(', ') || '∅'}  ` +
      `total_cost_usd=${num(lastResult?.total_cost_usd)}`,
  );
  return keys;
}

// ──────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  // Force the Claude model path BEFORE importing config/orchestrator (the model
  // ids bind at module load). dotenv already populated .env above; we overwrite.
  if (!KEEP_ENV) {
    process.env.GEORGE_MODEL_FAST = FORCE_FAST;
    process.env.GEORGE_MODEL_SMART = FORCE_SMART;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '\n✖ ANTHROPIC_API_KEY is not set. This spike validates the Claude cost/modelUsage\n' +
        '  fields, so it needs a real Claude key. Set ANTHROPIC_API_KEY in .env and retry\n' +
        '  (or pass --keep-env to run on whatever GEORGE_MODEL_* your .env points at).',
    );
    process.exit(1);
  }

  banner('SDK TELEMETRY SPIKE');
  console.log(`  forcing models: ${KEEP_ENV ? 'NO (--keep-env, using .env)' : `FAST=${FORCE_FAST}  SMART=${FORCE_SMART}`}`);
  console.log('  NOTE: makes real LLM calls (a few cents). Writes NOTHING to the DB.');

  // Probe B first — cheapest, isolates Q5, and confirms the SDK even talks to Claude.
  if (RUN_SWAP) {
    banner('PROBE B — query({ model }) swap');
    try {
      const ka = await probeModelSwap(SWAP_A);
      const kb = await probeModelSwap(SWAP_B);
      obs.swapModels = [...ka, ...kb];
      // Distinct if the two runs reported different model keys, and each key
      // reflects the requested model family.
      obs.swapDistinct =
        ka.length > 0 && kb.length > 0 && ka.join() !== kb.join();
    } catch (err) {
      console.error('  ✖ swap probe failed:', (err as Error).message);
    }
  }

  // Dynamic import AFTER env is forced so config.ts reads the overwritten model ids.
  const { runOrchestrator } = await import('../src/agent/orchestrator.js');

  if (RUN_MAIN) await probeMain(runOrchestrator, 'know-things turn (success path)');
  if (RUN_ERROR) await probeMain(runOrchestrator, 'forced error path', 1);

  // ── SUMMARY: auto-answer the 5 gating questions from observed data ──
  banner('SUMMARY — the 5 gating questions');
  const mark = (v: boolean | null) => (v === null ? '⚠️  inconclusive' : v ? '✅ YES' : '❌ NO');
  console.log(`  Q1  usage.input/output_tokens on result ........ ${mark(obs.usageTokens)}`);
  console.log(`  Q2  total_cost_usd + modelUsage present ........ ${mark(obs.costAndModelUsage)}`);
  console.log(
    `        (models that ran on the real turn: ${obs.mainModelUsageKeys.join(', ') || '∅'})`,
  );
  console.log(`  Q3  ERROR branch still carries cost/usage ...... ${mark(obs.errorBranchCost)}`);
  console.log(
    `  Q4  sub-agent dispatch + tool_result visible ... ${mark(
      obs.sawSubAgentDispatch && obs.sawToolResult,
    )}  (dispatch=${obs.sawSubAgentDispatch} tool_result=${obs.sawToolResult})`,
  );
  console.log(`  Q5  query({model}) swaps the model ............. ${mark(obs.swapDistinct)}`);
  if (obs.swapModels.length) console.log(`        (swap probe reported: ${obs.swapModels.join(', ')})`);

  console.log('\n  Abort/supersede branch (Spectrum AbortController) is NOT exercised here —');
  console.log('  it produces NO result message at all; verify recordTurn writes an');
  console.log("  outcome='aborted' row from the catch/abort handler. See §4.1 of the note.\n");

  process.exit(0);
}

main().catch((err) => {
  console.error('spike error:', err);
  process.exit(1);
});
