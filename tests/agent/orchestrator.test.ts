import { describe, it, expect } from 'vitest';
import { runOrchestrator, buildOrchestratorPrompt } from '../../src/agent/orchestrator.js';

describe('buildOrchestratorPrompt', () => {
  it('concatenates master + orchestrator prompts', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toMatch(/george/i);
    expect(prompt).toMatch(/find-people/);
    expect(prompt).toMatch(/whats-happening/);
    expect(prompt).toMatch(/know-things/);
  });
});

describe('runOrchestrator (mock mode)', () => {
  it('dispatches a squad request and returns stream', async () => {
    const events: { type: string; text?: string }[] = [];
    const stream = runOrchestrator({
      userId: 'test-user-001',
      channel: 'imessage',
      text: 'hey i wanna find people to go hiking saturday',
      sessionStore: undefined,
      mockMode: true,
    });
    for await (const event of stream) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('handles refusal categories without invoking sub-agents', async () => {
    const events: { type: string; text?: string }[] = [];
    const stream = runOrchestrator({
      userId: 'test-user-001',
      channel: 'imessage',
      text: 'i think i need to see a doctor',
      sessionStore: undefined,
      mockMode: true,
    });
    for await (const event of stream) {
      events.push(event);
    }
    const text = events.map((e) => e.text ?? '').join('');
    expect(text.toLowerCase()).toMatch(/engemann|213-740/);
  });
});
