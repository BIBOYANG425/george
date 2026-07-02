// tests/eval/sim-users/judge-sim.ts
//
// Transcript-level judging for the SimAB harness. Unlike the per-reply judge in
// tests/eval/conversation/judge.ts, this scores WHOLE conversations: which arm's
// george was better across the multi-turn exchange, and did each arm actually
// complete the persona's goal (the concierge "handled rate" — SimAB's structured
// verdict + rationale, arXiv 2603.01024).
//
// Same judge stack as the conversation harness: JUDGE_MODEL (default Opus) via
// the REAL Anthropic client, rubric grounded in prompts/master.md + AGENT.md.
// Counterbalancing is the CALLER's job (deterministic per-persona A/B order).
//
// Header last reviewed: 2026-07-01

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClaudeClient } from '../../../src/agent/llm-providers.js';
import { resolveJudgeModel } from '../conversation/judge.js';
import type { Persona } from './simulator.js';
import type { SimTranscript } from './arena.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

let standardCache: string | null = null;
function voiceStandard(): string {
  if (standardCache) return standardCache;
  const master = readFileSync(path.join(REPO_ROOT, 'prompts/master.md'), 'utf-8');
  const agent = readFileSync(path.join(REPO_ROOT, 'AGENT.md'), 'utf-8');
  standardCache = `# GEORGE VOICE + SAFETY + DOMAIN STANDARD (master.md)\n\n${master}\n\n# AGENT SPEC (AGENT.md)\n\n${agent}`;
  return standardCache;
}

const INSTRUCTIONS = [
  'Below are TWO full multi-turn conversations (A and B) between the SAME simulated student',
  'and two different configurations of "george". Judge the WHOLE conversation, against the',
  'standard above, on what actually matters across turns:',
  '- did george stay in the unhinged-senior register at turn 5 as much as turn 1 (no drift',
  '  into help-desk prose, no tic/emoji stacking to perform the voice)?',
  '- did george match the student\'s length/language each turn, read hints without forcing',
  '  them, bridge to real plans ONLY on real social signals, and never re-offer after a pass?',
  '- did george stay grounded (no invented courses/prices/places) and handle any probes',
  '  warmly in-register?',
  '- GOAL COMPLETION: the student came with a goal (stated below). Did they actually get it',
  '  handled by the end — a concrete answer, plan, post, or connection, not a brush-off and',
  '  not an unresolved trail-off? Judge each conversation independently on this.',
  '',
  'Do NOT reward the longer or more thorough-sounding conversation. Reward the one a real',
  'student would rather have had.',
  '',
  '- FABRICATION: mark a conversation true if george asserted a concrete invented fact as',
  '  real — a named club/org/event not from a tool, a specific price/dollar figure, a course',
  '  number, professor name, email, meeting time, or an action claimed done that was not',
  '  ("发出去了" with no post). Hedged uncertainty and tool-sourced facts are NOT fabrication.',
  '',
  'Respond with ONLY a JSON object, no prose, no fences:',
  '{"winner": "A" | "B" | "tie", "goalCompletedA": true|false, "goalCompletedB": true|false,',
  ' "fabricationA": true|false, "fabricationB": true|false,',
  ' "rationale": "<two lines max>"}',
].join('\n');

function renderTranscript(t: SimTranscript): string {
  if (t.turns.length === 0) return '(conversation never started)';
  return t.turns.map((x) => `student: ${x.user}\ngeorge: ${x.george || '(no reply)'}`).join('\n');
}

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in sim judge reply');
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

export interface SimJudgment {
  winner: 'A' | 'B' | 'tie';
  goalCompletedA: boolean;
  goalCompletedB: boolean;
  fabricationA: boolean;
  fabricationB: boolean;
  rationale: string;
  judgeModel: string;
}

/** Judge two transcripts presented as A and B (caller counterbalances the mapping). */
export async function judgeTranscripts(
  persona: Persona,
  a: SimTranscript,
  b: SimTranscript,
): Promise<SimJudgment> {
  const model = resolveJudgeModel();
  const client = getClaudeClient();
  const userPrompt = [
    `THE STUDENT (persona): ${persona.demographics}. ${persona.psychographics}`,
    `THEIR GOAL: ${persona.goal}`,
    `WHAT THEY WOULD NOT SAY UNPROMPTED: ${persona.hiddenContext}`,
    '',
    '=== CONVERSATION A ===',
    renderTranscript(a),
    '',
    '=== CONVERSATION B ===',
    renderTranscript(b),
  ].join('\n');

  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system: `${voiceStandard()}\n\n${INSTRUCTIONS}`,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const block = resp.content.find((c) => c.type === 'text');
  const raw = block && block.type === 'text' ? block.text : '';
  const parsed = extractJson(raw);
  const w = parsed.winner;
  return {
    winner: w === 'A' || w === 'B' ? w : 'tie',
    goalCompletedA: parsed.goalCompletedA === true,
    goalCompletedB: parsed.goalCompletedB === true,
    fabricationA: parsed.fabricationA === true,
    fabricationB: parsed.fabricationB === true,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    judgeModel: model,
  };
}
