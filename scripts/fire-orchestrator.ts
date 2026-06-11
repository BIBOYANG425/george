// scripts/fire-orchestrator.ts
// One-off: replay a message that the live george missed during a tsx-watch
// restart window. Runs the orchestrator with the user's text, extracts the
// final assistant reply, and sends it via a fresh @photon-ai/imessage-kit
// SDK instance. Designed to be run from the george repo root: pnpm tsx scripts/fire-orchestrator.ts

import 'dotenv/config';
import { runOrchestrator } from '../src/agent/orchestrator.js';
import { IMessageSDK } from '@photon-ai/imessage-kit';

const SENDER = '+17474638880';
const TEXT = '请你告诉我LA的公寓最好的是哪一';

async function main() {
  console.log(`[manual] firing orchestrator for ${SENDER}: "${TEXT}"`);

  let finalText = '';
  let eventCount = 0;
  for await (const event of runOrchestrator({
    userId: SENDER,
    channel: 'imessage',
    text: TEXT,
  })) {
    eventCount++;
    const e = event as {
      type?: string;
      result?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (e.type === 'result' && typeof e.result === 'string' && e.result.length > 0) {
      finalText = e.result;
    } else if (e.type === 'assistant' && e.message?.content && finalText === '') {
      const text = e.message.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (text) finalText = text;
    }
  }

  console.log(`[manual] events=${eventCount} textLen=${finalText.length}`);
  console.log(`[manual] preview: ${finalText.slice(0, 200)}`);

  if (!finalText) {
    console.error('[manual] orchestrator returned no text');
    process.exit(1);
  }

  const sdk = new IMessageSDK({ debug: false });
  await sdk.send(SENDER, finalText);
  console.log(`[manual] sent to ${SENDER}`);
  await sdk.close();
  console.log('[manual] done');
}

main().catch((err) => {
  console.error('[manual] error:', err);
  process.exit(1);
});
