// tests/agent/relationship.test.ts

// Stub required env vars BEFORE config.ts loads — the relationship evaluator
// imports config (for the SMART model tier) which throws on missing keys.
// (Same pattern as tests/tools/get-course-reviews.test.ts.) These run before the
// dynamic imports inside each test.
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_ANON_KEY ||= 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The evaluator calls callLightweightLLM under the hood; mock that module so the
// test never hits a real model (precedent: heartbeat tests mock the LLM client).
vi.mock('../../src/agent/llm-providers.js', () => ({
  callLightweightLLM: vi.fn(),
}));

import { createInMemoryCache } from '../../src/memory/kv-cache';
import { ProfileStore, BLOCK_NAMES, extractRelationshipNote } from '../../src/memory/profile';
import { callLightweightLLM } from '../../src/agent/llm-providers.js';

// Statically importing the evaluator would run config.ts at hoist time (before the
// env stubs above), so load it lazily once the stubs are in place.
type RelMod = typeof import('../../src/agent/evaluators/relationship.js');
let rel: RelMod;
beforeEach(async () => {
  rel = await import('../../src/agent/evaluators/relationship.js');
});

function makeStore() {
  const cache = createInMemoryCache();
  const rows = new Map<string, Record<string, string>>();
  const db = {
    async loadRow(userId: string) {
      return rows.get(userId) ?? null;
    },
    async upsertBlock(userId: string, block: string, content: string) {
      const existing = rows.get(userId) ?? Object.fromEntries(BLOCK_NAMES.map((b) => [b, '']));
      existing[block] = content;
      rows.set(userId, existing);
    },
  };
  return { store: new ProfileStore(db, cache) };
}

describe('shouldRunRelationshipEval', () => {
  it('never runs on zero messages', () => {
    expect(rel.shouldRunRelationshipEval(0)).toBe(false);
  });

  it('runs on every Nth user message', () => {
    expect(rel.shouldRunRelationshipEval(rel.RELATIONSHIP_EVAL_EVERY)).toBe(true);
    expect(rel.shouldRunRelationshipEval(rel.RELATIONSHIP_EVAL_EVERY * 2)).toBe(true);
  });

  it('does not run between multiples', () => {
    expect(rel.shouldRunRelationshipEval(1)).toBe(false);
    expect(rel.shouldRunRelationshipEval(rel.RELATIONSHIP_EVAL_EVERY - 1)).toBe(false);
    expect(rel.shouldRunRelationshipEval(rel.RELATIONSHIP_EVAL_EVERY + 1)).toBe(false);
  });
});

describe('sanitizeNote', () => {
  it('trims and passes through plain prose', () => {
    expect(rel.sanitizeNote('  they text late and terse  ')).toBe('they text late and terse');
  });

  it('strips wrapping code fences', () => {
    expect(rel.sanitizeNote('```\nwarm rapport\n```')).toBe('warm rapport');
  });

  it('strips wrapping quotes', () => {
    expect(rel.sanitizeNote('"leans on George for housing"')).toBe('leans on George for housing');
  });

  it('clamps overly long notes', () => {
    const long = 'x'.repeat(900);
    expect(rel.sanitizeNote(long).length).toBeLessThanOrEqual(600);
  });

  it('handles empty / nullish input', () => {
    expect(rel.sanitizeNote('')).toBe('');
    expect(rel.sanitizeNote(undefined as unknown as string)).toBe('');
  });
});

describe('isRelationshipEvalEnabled', () => {
  const orig = process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    else process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = orig;
  });

  it('is OFF when unset', () => {
    delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    expect(rel.isRelationshipEvalEnabled()).toBe(false);
  });

  it('is ON only for the exact string "true"', () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    expect(rel.isRelationshipEvalEnabled()).toBe(true);
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = '1';
    expect(rel.isRelationshipEvalEnabled()).toBe(false);
  });
});

describe('runRelationshipEval', () => {
  const orig = process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
  beforeEach(() => {
    vi.mocked(callLightweightLLM).mockReset();
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    else process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = orig;
  });

  it('is a no-op (no LLM call, no write) when the flag is OFF', async () => {
    delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    const { store } = makeStore();
    await rel.runRelationshipEval({
      store,
      userId: 'u1',
      recentMessages: [{ role: 'user', content: 'hi 学长' }],
    });
    expect(callLightweightLLM).not.toHaveBeenCalled();
    const p = await store.loadProfile('u1');
    expect(p.george_notes).toBe('');
  });

  it('writes the rewritten note into george_notes when ON', async () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    vi.mocked(callLightweightLLM).mockResolvedValue('they text terse and late, mostly CS coursework stress');
    const { store } = makeStore();
    await rel.runRelationshipEval({
      store,
      userId: 'u2',
      recentMessages: [
        { role: 'user', content: '凌晨三点还在赶 CS 作业' },
        { role: 'assistant', content: '狠狠共情了' },
      ],
    });
    expect(callLightweightLLM).toHaveBeenCalledTimes(1);
    const p = await store.loadProfile('u2');
    expect(extractRelationshipNote(p.george_notes)).toBe(
      'they text terse and late, mostly CS coursework stress',
    );
  });

  it('runs on the SMART model tier', async () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    vi.mocked(callLightweightLLM).mockResolvedValue('warm rapport');
    const { store } = makeStore();
    await rel.runRelationshipEval({
      store,
      userId: 'u3',
      recentMessages: [{ role: 'user', content: 'hey' }],
    });
    const opts = vi.mocked(callLightweightLLM).mock.calls[0][1] as { model?: string };
    expect(opts.model).toBeTruthy();
    // SMART tier is Sonnet by default (config.models.smart).
    expect(opts.model).toContain('sonnet');
  });

  it('does not write when the rewrite is identical to the prior note', async () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    const { store } = makeStore();
    // Seed an existing note via a first rewrite.
    vi.mocked(callLightweightLLM).mockResolvedValue('steady rapport');
    await rel.runRelationshipEval({
      store,
      userId: 'u4',
      recentMessages: [{ role: 'user', content: 'hey' }],
    });
    const saveSpy = vi.spyOn(store, 'saveBlock');
    // Model returns the same note again.
    vi.mocked(callLightweightLLM).mockResolvedValue('steady rapport');
    await rel.runRelationshipEval({
      store,
      userId: 'u4',
      recentMessages: [{ role: 'user', content: 'hey again' }],
    });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('swallows LLM errors (fire-and-forget never throws)', async () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    vi.mocked(callLightweightLLM).mockRejectedValue(new Error('boom'));
    const { store } = makeStore();
    await expect(
      rel.runRelationshipEval({ store, userId: 'u5', recentMessages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBeUndefined();
    const p = await store.loadProfile('u5');
    expect(p.george_notes).toBe('');
  });
});

// ── relationshipEvaluator adapter (thin delegate over the functions above) ──
describe('relationshipEvaluator adapter', () => {
  const orig = process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
  beforeEach(() => {
    vi.mocked(callLightweightLLM).mockReset();
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    else process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = orig;
  });

  it('has the stable shape (name / kind / trigger)', () => {
    expect(rel.relationshipEvaluator.name).toBe('relationship_eval');
    expect(rel.relationshipEvaluator.kind).toBe('llm');
    expect(rel.relationshipEvaluator.trigger).toBe('turn');
  });

  it('isEnabled tracks the existing flag exactly', () => {
    delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    expect(rel.relationshipEvaluator.isEnabled()).toBe(rel.isRelationshipEvalEnabled());
    expect(rel.relationshipEvaluator.isEnabled()).toBe(false);
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    expect(rel.relationshipEvaluator.isEnabled()).toBe(true);
  });

  it('shouldRun delegates to shouldRunRelationshipEval with ctx.userMessageCount', () => {
    // Cadence source: the CUMULATIVE count passed through ctx (NOT a window len).
    expect(rel.relationshipEvaluator.shouldRun({ trigger: 'turn', userMessageCount: rel.RELATIONSHIP_EVAL_EVERY }))
      .toBe(true);
    expect(rel.relationshipEvaluator.shouldRun({ trigger: 'turn', userMessageCount: rel.RELATIONSHIP_EVAL_EVERY - 1 }))
      .toBe(false);
    // Missing count defaults to 0 -> never runs.
    expect(rel.relationshipEvaluator.shouldRun({ trigger: 'turn' })).toBe(false);
  });

  it('run() is a no-op when the flag is OFF (delegates to runRelationshipEval gate)', async () => {
    delete process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED;
    const { store } = makeStore();
    const sessionStore = {
      load: vi.fn(async () => ({ sessionId: 'u', messages: [{ role: 'user' as const, content: 'hi' }], systemContext: {} })),
      save: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
      countUserMessages: vi.fn(async () => 5),
    };
    await rel.relationshipEvaluator.run({
      trigger: 'turn',
      userId: 'u',
      sessionStore,
      profileStore: store,
      userMessageCount: 5,
    });
    expect(callLightweightLLM).not.toHaveBeenCalled();
  });

  it('run() loads the session, filters, and calls runRelationshipEval when ON', async () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    vi.mocked(callLightweightLLM).mockResolvedValue('warm rapport, terse late texter');
    const { store } = makeStore();
    const sessionStore = {
      load: vi.fn(async () => ({
        sessionId: 'u9',
        messages: [
          { role: 'user' as const, content: '凌晨在赶 due' },
          { role: 'assistant' as const, content: '狠狠共情' },
          { role: 'system' as const, content: 'should be filtered out' },
        ],
        systemContext: {},
      })),
      save: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
      countUserMessages: vi.fn(async () => rel.RELATIONSHIP_EVAL_EVERY),
    };
    await rel.relationshipEvaluator.run({
      trigger: 'turn',
      userId: 'u9',
      sessionStore,
      profileStore: store,
      userMessageCount: rel.RELATIONSHIP_EVAL_EVERY,
    });
    expect(sessionStore.load).toHaveBeenCalledWith('u9');
    expect(callLightweightLLM).toHaveBeenCalledTimes(1);
    // Only user/assistant string messages reach the transcript (system filtered).
    const userPrompt = vi.mocked(callLightweightLLM).mock.calls[0][0][1].content as string;
    expect(userPrompt).toContain('凌晨在赶 due');
    expect(userPrompt).not.toContain('should be filtered out');
  });

  it('run() returns (no throw) when stores are missing', async () => {
    process.env.GEORGE_RELATIONSHIP_EVAL_ENABLED = 'true';
    await expect(
      rel.relationshipEvaluator.run({ trigger: 'turn', userId: 'u' }),
    ).resolves.toBeUndefined();
    expect(callLightweightLLM).not.toHaveBeenCalled();
  });
});
