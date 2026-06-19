import { describe, it, expect, afterEach } from 'vitest';
import { runOrchestrator, buildOrchestratorPrompt, isProfileEmpty, buildAgentsConfig } from '../../src/agent/orchestrator.js';
import type { Profile } from '../../src/memory/profile.js';
import { upsertRelationshipNote } from '../../src/memory/profile.js';

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

describe('relationship-note injection (P3, default-OFF flag)', () => {
  const orig = process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    else process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = orig;
  });

  const noteText = 'they text terse and late-night, mostly CS coursework stress';
  const profileWithNote = (): Profile => ({
    identity: '', academic: '', interests: '', relationships: '', state: '',
    george_notes: upsertRelationshipNote('keep this heartbeat scratch', noteText),
  });

  it('flag OFF: no # RELATIONSHIP NOTE section, and the raw sentinel/note are not leaked', () => {
    delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    const prompt = buildOrchestratorPrompt(profileWithNote());
    expect(prompt).not.toMatch(/^# RELATIONSHIP NOTE$/m);
  });

  it('flag ON: surfaces the note under its own header exactly once', () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    const prompt = buildOrchestratorPrompt(profileWithNote());
    expect(prompt).toMatch(/^# RELATIONSHIP NOTE$/m);
    expect(prompt).toContain(noteText);
    // Shown once (in the dedicated section), not duplicated inside USER PROFILE.
    expect(prompt.split(noteText).length - 1).toBe(1);
    // The non-note george_notes content still renders in USER PROFILE.
    expect(prompt).toContain('keep this heartbeat scratch');
    // Sentinel markers never leak into the prompt.
    expect(prompt).not.toContain('relationship_note:start');
  });

  it('flag ON but no note present: no # RELATIONSHIP NOTE section', () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    const profile: Profile = {
      identity: '', academic: '', interests: '', relationships: '', state: '', george_notes: '',
    };
    expect(buildOrchestratorPrompt(profile)).not.toMatch(/^# RELATIONSHIP NOTE$/m);
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

describe('buildAgentsConfig — student_id reaches the squad sub-agent', () => {
  it('injects the # CURRENT STUDENT block into find-people when a studentId is given', () => {
    const cfg = buildAgentsConfig(null, '11111111-2222-3333-4444-555555555555');
    expect(cfg['find-people'].prompt).toMatch(/# CURRENT STUDENT/);
    expect(cfg['find-people'].prompt).toContain('11111111-2222-3333-4444-555555555555');
  });
  it('omits the block when no studentId', () => {
    const cfg = buildAgentsConfig(null, null);
    expect(cfg['find-people'].prompt).not.toMatch(/# CURRENT STUDENT/);
  });
})

describe('web search wiring (search Phase 1)', () => {
  it('gives whats-happening + know-things WebSearch + find_places when allowed; find-people gets neither', () => {
    const cfg = buildAgentsConfig(null, null, true);
    expect(cfg['whats-happening'].tools).toContain('WebSearch');
    expect(cfg['know-things'].tools).toContain('WebSearch');
    expect(cfg['whats-happening'].tools).toContain('mcp__george__find_places');
    expect(cfg['know-things'].tools).toContain('mcp__george__find_places');
    expect(cfg['find-people'].tools).not.toContain('WebSearch');
    expect(cfg['find-people'].tools).not.toContain('mcp__george__find_places');
  });
  it('omits WebSearch + its guidance when over the daily cap', () => {
    const cfg = buildAgentsConfig(null, null, false);
    expect(cfg['whats-happening'].tools).not.toContain('WebSearch');
    expect(cfg['whats-happening'].prompt).not.toMatch(/allowed_domains/);
  });
  it('injects trusted-domain guidance into the info agents when web is allowed', () => {
    const cfg = buildAgentsConfig(null, null, true);
    expect(cfg['whats-happening'].prompt).toMatch(/allowed_domains/);
    expect(cfg['whats-happening'].prompt).toMatch(/xiaohongshu\.com/);
  });
})
