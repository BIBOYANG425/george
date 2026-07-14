// tests/agent/multimodal-prompt.test.ts
//
// Unit tests for buildClaudePrompt — the text-string vs multimodal-generator
// branch that feeds the orchestrator's Claude query(). Proves the text path is a
// plain string (unchanged) and the image path yields one multimodal user message
// with the text block first and one base64 image block per image.

import { describe, it, expect } from 'vitest';
import { buildClaudePrompt } from '../../src/agent/multimodal-prompt.js';
import type { ImagePart } from '../../src/agent/image-part.js';

async function collect(prompt: string | AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const m of prompt as AsyncIterable<unknown>) out.push(m);
  return out;
}

describe('buildClaudePrompt', () => {
  it('returns the plain string when there are no images (text turn unchanged)', () => {
    expect(buildClaudePrompt('hi 学长')).toBe('hi 学长');
    expect(buildClaudePrompt('hi', [])).toBe('hi');
  });

  it('yields one multimodal user message: text block first, then image blocks', async () => {
    const images: ImagePart[] = [
      { mimeType: 'image/png', dataBase64: 'PNGDATA' },
      { mimeType: 'image/jpeg', dataBase64: 'JPGDATA' },
    ];
    const prompt = buildClaudePrompt('what class is this', images);
    expect(typeof prompt).not.toBe('string');
    const msgs = await collect(prompt);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as { type: string; parent_tool_use_id: null; message: { role: string; content: unknown[] } };
    expect(m.type).toBe('user');
    expect(m.parent_tool_use_id).toBeNull();
    expect(m.message.role).toBe('user');
    const content = m.message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3); // 1 text + 2 images
    expect(content[0]).toEqual({ type: 'text', text: 'what class is this' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } });
    expect(content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'JPGDATA' } });
  });

  it('falls back to a marker text block for an image-only turn (empty text)', async () => {
    const prompt = buildClaudePrompt('', [{ mimeType: 'image/webp', dataBase64: 'WEBP' }]);
    const msgs = await collect(prompt);
    const content = (msgs[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content[0]).toEqual({ type: 'text', text: '(image)' });
    expect(content[1]).toMatchObject({ type: 'image', source: { media_type: 'image/webp', data: 'WEBP' } });
  });
});
