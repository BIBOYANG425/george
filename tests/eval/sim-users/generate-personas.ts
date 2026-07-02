// tests/eval/sim-users/generate-personas.ts
//
// Generates the STATISTICAL persona panel: N ordinary USC students with no
// engineered edge-case attributes (founder directive 2026-07-01: "just normal
// people with no specific attribute that we are target"). Complements the
// hand-curated diagnostic panel in fixtures/personas.json — that one probes
// specific behaviors; this one samples the population so win rate / handled
// rate / fabrication rate carry statistical meaning (SimAB, arXiv 2603.01024:
// accuracy scaled with agent count and persona diversity).
//
// Generated ONCE and frozen to fixtures/generated-personas.json so runs are
// reproducible; regenerate deliberately by re-running this script.
//
//   npx tsx tests/eval/sim-users/generate-personas.ts [count]
//
// Uses the fast Claude tier via the real client. Cost: cents.

import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClaudeClient } from '../../../src/agent/llm-providers.js';
import { config } from '../../../src/config.js';
import type { Persona } from './simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'fixtures/generated-personas.json');
const COUNT = Math.max(10, parseInt(process.argv[2] || '100', 10));
const BATCH = 10;

const GEN_SYSTEM = [
  'You generate realistic, ORDINARY USC student personas for a conversation simulation.',
  'These are normal students texting a student-run campus助手 called george on iMessage.',
  '',
  'HARD RULES:',
  '- Ordinary people, ordinary needs. NO engineered edge cases, no adversarial probes,',
  '  no extreme personalities. The mundane middle of the distribution.',
  '- Mundane goals only: food, classes, events, boredom, homework spots, gym, errands,',
  '  weekend plans, roommate logistics, campus questions. One goal per persona.',
  '- Mix: ~60% Chinese international (texting in Chinese or mixed zh/en), ~40% other',
  '  (domestic + other international, texting in English). All years, varied majors.',
  '- Texting styles vary naturally: terse/chatty, punctuation habits, emoji or none.',
  '- hiddenContext is usually "none"; at most something mundane (a budget, a schedule',
  '  clash) for ~1 in 5 personas. Never dramatic.',
  '- openers are what a real student ACTUALLY sends first: short, unpolished, in the',
  '  persona\'s language. Not a paragraph.',
  '- maxTurns between 3 and 5.',
  '- profile: a plausible {identity, academic, interests, state} matching the persona.',
  '',
  'Every persona in a batch must be a clearly DIFFERENT person (major, origin, year,',
  'style, goal). Respond with ONLY a JSON array of persona objects, no prose, each:',
  '{"id": "<kebab-slug>", "demographics": "...", "psychographics": "...", "texting": "...",',
  ' "goal": "...", "hiddenContext": "none" | "...", "opener": "...", "maxTurns": 3|4|5,',
  ' "profile": {"identity": "...", "academic": "...", "interests": "...", "state": "..."}}',
].join('\n');

function extractArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('no JSON array in generator reply');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown[];
}

async function main(): Promise<void> {
  const client = getClaudeClient();
  const personas: Persona[] = [];
  const seenIds = new Set<string>();
  let batchNo = 0;

  while (personas.length < COUNT) {
    batchNo++;
    const need = Math.min(BATCH, COUNT - personas.length);
    const resp = await client.messages.create({
      model: config.models.fast,
      max_tokens: 4096,
      system: GEN_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Generate batch #${batchNo}: ${need} personas. Already used ids (make new ones distinct): ${[...seenIds].slice(-30).join(', ') || '(none)'}`,
        },
      ],
    });
    const block = resp.content.find((b) => b.type === 'text');
    const raw = block && block.type === 'text' ? block.text : '';
    for (const p of extractArray(raw) as Persona[]) {
      if (!p?.id || seenIds.has(p.id) || !p.opener || !p.goal) continue;
      seenIds.add(p.id);
      personas.push({ ...p, id: `gen-${String(personas.length + 1).padStart(3, '0')}-${p.id}`, maxTurns: Math.min(5, Math.max(3, p.maxTurns || 4)) });
      if (personas.length >= COUNT) break;
    }
    console.log(`batch ${batchNo}: ${personas.length}/${COUNT}`);
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        _comment: `Generated statistical panel: ${personas.length} ordinary USC students (no targeted attributes). Frozen for reproducibility; regenerate via generate-personas.ts.`,
        generatedAt: new Date().toISOString(),
        model: config.models.fast,
        personas,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${personas.length} personas -> ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
