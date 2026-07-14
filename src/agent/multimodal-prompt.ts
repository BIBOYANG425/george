// Build the Claude Agent SDK query() prompt for one orchestrator turn.
//
// Text-only turns pass a plain string, byte-identical to the pre-image behavior.
// A turn that carries inbound images (image intake, default-OFF) instead passes a
// one-shot streaming-input generator: a single multimodal user message whose
// content is the text block followed by one image block per image. The SDK closes
// the turn when this generator ends (it yields exactly once), so no further input
// is expected — same lifecycle as a string prompt.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImagePart } from './image-part.js';

export function buildClaudePrompt(
  text: string,
  images?: ImagePart[],
): string | AsyncIterable<SDKUserMessage> {
  const imgs = images ?? [];
  if (imgs.length === 0) return text;
  return (async function* () {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          // A non-empty text block is always present. Image-only turns arrive with
          // '' from the transport, so fall back to a minimal marker rather than
          // emit an empty text block.
          { type: 'text', text: text || '(image)' },
          ...imgs.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mimeType, data: img.dataBase64 },
          })),
        ],
      },
    } satisfies SDKUserMessage;
  })();
}
