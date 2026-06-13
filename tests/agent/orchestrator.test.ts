import { describe, it, expect } from 'vitest';
import { runOrchestrator, buildOrchestratorPrompt, isProfileEmpty } from '../../src/agent/orchestrator.js';
import type { Profile } from '../../src/memory/profile.js';

describe('buildOrchestratorPrompt', () => {
  it('concatenates master + orchestrator prompts', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toMatch(/george/i);
    expect(prompt).toMatch(/find-people/);
    expect(prompt).toMatch(/whats-happening/);
    expect(prompt).toMatch(/know-things/);
  });
});

describe('orchestrator profile injection', () => {
  it('renders profile blocks into system prompt', () => {
    const profile: Profile = {
      identity: 'name: Alice\nyear: junior',
      academic: '',
      interests: 'hobbies: hiking, food',
      relationships: '',
      state: '',
      george_notes: '',
    };
    const prompt = buildOrchestratorPrompt(profile);
    expect(prompt).toMatch(/^# USER PROFILE$/m);
    expect(prompt).toContain('name: Alice');
    expect(prompt).toContain('hobbies: hiking, food');
  });

  it('handles empty profile gracefully — all blocks show (empty)', () => {
    const emptyProfile: Profile = {
      identity: '', academic: '', interests: '', relationships: '', state: '', george_notes: '',
    };
    const prompt = buildOrchestratorPrompt(emptyProfile);
    expect(prompt).toMatch(/^# USER PROFILE$/m);
    // All 6 blocks should render with the (empty) placeholder
    const matches = prompt.match(/\(empty\)/g);
    expect(matches?.length).toBe(6);
  });

  it('handles null/undefined profile (no # USER PROFILE section header)', () => {
    const prompt = buildOrchestratorPrompt(null);
    // The master prompt contains the phrase "USER PROFILE" in prose; the injected
    // block adds a markdown H1 "# USER PROFILE". Check that the H1 header is absent.
    expect(prompt).not.toMatch(/^# USER PROFILE$/m);
  });
});

describe('onboarding nudge (soft gate, not a hard gate)', () => {
  const filled: Profile = {
    identity: 'name: Bob', academic: '', interests: '', relationships: '', state: '', george_notes: '',
  };
  const empty: Profile = {
    identity: '', academic: '', interests: '', relationships: '', state: '', george_notes: '',
  };

  it('isProfileEmpty: true for null/undefined/all-empty, false when any block has content', () => {
    expect(isProfileEmpty(null)).toBe(true);
    expect(isProfileEmpty(undefined)).toBe(true);
    expect(isProfileEmpty(empty)).toBe(true);
    expect(isProfileEmpty(filled)).toBe(false);
  });

  it('appends the nudge while the student is unknown (null / empty / no profile)', () => {
    expect(buildOrchestratorPrompt(null)).toMatch(/^# ONBOARDING/m);
    expect(buildOrchestratorPrompt(empty)).toMatch(/^# ONBOARDING/m);
    expect(buildOrchestratorPrompt()).toMatch(/^# ONBOARDING/m);
  });

  it('drops the nudge once george knows the student', () => {
    expect(buildOrchestratorPrompt(filled)).not.toMatch(/^# ONBOARDING/m);
  });

  it('the nudge is answer-first, never a gate', () => {
    const p = buildOrchestratorPrompt(null);
    expect(p).toMatch(/ALWAYS help them fully/);
    expect(p).toMatch(/never refuse, stall, or gate/i);
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
