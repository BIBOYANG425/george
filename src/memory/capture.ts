// src/memory/capture.ts
//
// Per-turn long-term memory capture. After each conversation turn, extract any
// durable new fact the student revealed and append it to the right profile block
// via ProfileStore.appendToBlock (safe, de-duped accumulate). Runs
// fire-and-forget so it never slows the reply.
//
// Before this, a stated fact only persisted if a later heartbeat tick (~12h
// cadence, and only when HEARTBEAT_ENABLED) folded it in, or via /correct — so
// "George remembers what I just told him" did not really hold. This closes that
// latency gap by writing high-signal facts on the same turn.
//
// Gated by MEMORY_CAPTURE_ENABLED (default OFF) so it never writes to user
// profiles unless explicitly enabled (important: profiles hold real PII).

import { callLightweightLLM } from '../agent/llm-providers.js';
import { ProfileStore, BLOCK_NAMES, BlockName } from './profile.js';
import { log } from '../observability/logger.js';

export function isCaptureEnabled(): boolean {
  return process.env.MEMORY_CAPTURE_ENABLED === 'true';
}

// Blocks the capturer may write to. george_notes is George's own scratchpad, not
// a place for extracted user facts, so it is excluded.
const CAPTURE_BLOCKS: BlockName[] = BLOCK_NAMES.filter((b) => b !== 'george_notes');

const EXTRACT_SYSTEM = [
  "You extract durable, long-term facts about a student from ONE chat turn, for an AI campus companion's memory.",
  'Return STRICT JSON only: {"facts":[{"block":"<identity|academic|interests|relationships|state>","fact":"<short third-person fact>"}]}',
  'Rules:',
  '- Capture ONLY durable facts worth remembering next time: major, year, hometown, dorm/housing, interests/hobbies, ongoing situations, relationships, stable preferences.',
  '- Do NOT capture transient chit-chat, the assistant\'s suggestions/questions, or anything the student did not clearly state.',
  '- Each fact: a short third-person statement, e.g. "studies CS, sophomore", "lives in the village", "into hiking and hotpot".',
  '- Never invent. Only what the student actually said. If nothing durable, return {"facts":[]}.',
].join('\n');

// callLightweightLLM's non-Kimi fallback does not force JSON, so be tolerant:
// pull the first {...} object out of whatever came back.
function parseFacts(raw: string): Array<{ block?: string; fact?: string }> {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return [];
    const obj = JSON.parse(raw.slice(start, end + 1)) as { facts?: Array<{ block?: string; fact?: string }> };
    return Array.isArray(obj.facts) ? obj.facts : [];
  } catch {
    return [];
  }
}

export async function captureFactsFromTurn(
  store: ProfileStore,
  userId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!isCaptureEnabled()) return;
  try {
    const raw = await callLightweightLLM(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `STUDENT: ${userText}\n\nGEORGE: ${assistantText}` },
      ],
      { maxTokens: 300, jsonMode: true },
    );
    const facts = parseFacts(raw);
    let written = 0;
    for (const f of facts) {
      const block = f.block as BlockName;
      if (!f.fact || !CAPTURE_BLOCKS.includes(block)) continue;
      await store.appendToBlock(userId, block, f.fact.trim());
      written++;
    }
    if (written) log('info', 'memory_capture', { userId, written });
  } catch (err) {
    log('warn', 'memory_capture_failed', { error: (err as Error).message });
  }
}
