// tests/eval/sim-users/simulator.ts
//
// The USER half of the SimAB harness (persona-conditioned simulated users, after
// arXiv 2603.01024): given a persona and the conversation so far, produce the
// student's next text message, or signal a natural stop.
//
// Deliberately runs on callLightweightLLM (Kimi when KIMI_API_KEY is set, else
// the Claude fast fallback) — a DIFFERENT model family from the Opus judge and
// (usually) from george's generation tier, to blunt same-model self-preference.
// The simulator's output is plain text; the sentinel [[DONE]] means the persona
// would naturally stop texting (goal met, satisfied, gave up, or wound down).
//
// Header last reviewed: 2026-07-01

import { callLightweightLLM } from '../../../src/agent/llm-providers.js';

export interface Persona {
  id: string;
  demographics: string;
  psychographics: string;
  texting: string;
  goal: string;
  hiddenContext: string;
  opener: string;
  maxTurns: number;
  profile?: Record<string, string>;
}

export interface SimTurn {
  user: string;
  george: string;
  durationMs?: number;
  tools: string[];
  fastPath: boolean;
  gateLiteFailures: string[];
}

export const DONE_SENTINEL = '[[DONE]]';

function transcriptText(turns: SimTurn[]): string {
  return turns
    .map((t) => `you: ${t.user}\ngeorge: ${t.george || '(no reply)'}`)
    .join('\n');
}

/**
 * Produce the persona's next message given the conversation so far. Returns
 * null when the persona would naturally stop (sentinel, empty, or LLM failure —
 * a dead simulator must never hang the arena; the transcript just ends there).
 */
export async function nextUserTurn(persona: Persona, turns: SimTurn[]): Promise<string | null> {
  const system = [
    'You are role-playing ONE specific USC student texting "george", a student-run campus助手',
    'on iMessage. Stay fully in character. You are a REAL PERSON texting, not an assistant.',
    '',
    `WHO YOU ARE: ${persona.demographics}. ${persona.psychographics}`,
    `HOW YOU TEXT: ${persona.texting}`,
    `WHAT YOU WANT FROM THIS CONVERSATION: ${persona.goal}`,
    `WHAT YOU WILL NOT SAY UNPROMPTED: ${persona.hiddenContext}`,
    '',
    'Rules:',
    '- Output ONLY your next text message. No quotes, no narration, no explanations.',
    '- Text like a real student: your specified length/register/language. Never sound like an AI.',
    '- React to what george actually said. Push back, follow up, change your mind, get',
    '  impatient or warmer, exactly as this person would.',
    `- When this person would naturally stop texting (got what they came for, satisfied,`,
    `  annoyed and giving up, or the conversation wound down), output exactly ${DONE_SENTINEL}`,
    '  and nothing else. Do not drag the conversation past its natural end.',
  ].join('\n');

  const user = [
    'Conversation so far (you are "you"):',
    transcriptText(turns) || '(you have not sent anything yet)',
    '',
    'Your next text message:',
  ].join('\n');

  try {
    const out = await callLightweightLLM(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { maxTokens: 200 },
    );
    const text = (out ?? '').trim();
    if (!text || text.includes(DONE_SENTINEL)) return null;
    return text;
  } catch {
    return null; // simulator failure ends the conversation gracefully
  }
}
