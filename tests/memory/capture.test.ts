// tests/memory/capture.test.ts
// Per-turn capture + P6 Observer. The same lightweight-LLM call emits durable
// FACTS (appended to profile blocks, gated by MEMORY_CAPTURE_ENABLED) and softer
// OBSERVATIONS (written to the observation log, gated by GEORGE_OBSERVE_ENABLED).
// Default-OFF on both flags = no LLM call, no writes (byte-identical to before).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted so the mock fns exist before the module factories run. Tests
// reconfigure them per-case (the LLM JSON, the resolved profile key).
const { llmMock, resolveMock, consentMock, embedMock, logMock } = vi.hoisted(() => ({
  llmMock: vi.fn(),
  resolveMock: vi.fn(),
  consentMock: vi.fn(),
  embedMock: vi.fn(),
  logMock: vi.fn(),
}));

vi.mock('../../src/agent/llm-providers.js', () => ({
  callLightweightLLM: llmMock,
}));

vi.mock('../../src/db/students.js', () => ({
  resolveProfileUserId: resolveMock,
  getMemoryConsent: consentMock,
}));

// Mock observations.js so embedObservation never touches Supabase and
// createSupabaseObservationDB is never the thing the test relies on (we inject a
// fake observationDB via deps). The factory is still mocked to a throwing stub so
// any accidental lazy construction in observe-on tests surfaces loudly.
vi.mock('../../src/memory/observations.js', () => ({
  embedObservation: embedMock,
  createSupabaseObservationDB: vi.fn(() => {
    throw new Error('createSupabaseObservationDB should not be constructed when a fake observationDB is injected');
  }),
}));

vi.mock('../../src/observability/logger.js', () => ({ log: logMock }));

import {
  captureFactsFromTurn,
  isCaptureEnabled,
  isObserveEnabled,
  isGroundedInStudentText,
  captureMetrics,
} from '../../src/memory/capture.js';

const HANDLE = '+17474638880';
const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// A ProfileStore stub that only records appendToBlock calls.
function makeStore() {
  const appends: Array<{ userId: string; block: string; content: string }> = [];
  return {
    appends,
    store: {
      async appendToBlock(userId: string, block: string, content: string) {
        appends.push({ userId, block, content });
      },
    } as any,
  };
}

// A fake ObservationDB recording insert() calls.
function makeObservationDB() {
  const inserts: Array<{ userId: string; obs: any; embedding: number[] | null }> = [];
  return {
    inserts,
    db: {
      async insert(userId: string, obs: any, embedding: number[] | null) {
        inserts.push({ userId, obs, embedding });
      },
      async recall() { return []; },
      async loadUnconsolidated() { return []; },
      async markConsolidated() {},
      async prune() { return 0; },
      async deleteForUser() {},
    } as any,
  };
}

beforeEach(() => {
  llmMock.mockReset();
  resolveMock.mockReset();
  consentMock.mockReset();
  embedMock.mockReset();
  logMock.mockReset();
  delete process.env.MEMORY_CAPTURE_ENABLED;
  delete process.env.GEORGE_OBSERVE_ENABLED;
  // Sensible defaults: handle resolves to a real uuid, the student has consented,
  // embedding present. Consent-denied cases override consentMock per-test.
  resolveMock.mockResolvedValue(UID);
  consentMock.mockResolvedValue(true);
  embedMock.mockResolvedValue([0.1, 0.2, 0.3]);
});

afterEach(() => {
  delete process.env.MEMORY_CAPTURE_ENABLED;
  delete process.env.GEORGE_OBSERVE_ENABLED;
});

describe('flag helpers', () => {
  it('isCaptureEnabled reflects MEMORY_CAPTURE_ENABLED', () => {
    expect(isCaptureEnabled()).toBe(false);
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    expect(isCaptureEnabled()).toBe(true);
  });

  it('isObserveEnabled reflects GEORGE_OBSERVE_ENABLED', () => {
    expect(isObserveEnabled()).toBe(false);
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    expect(isObserveEnabled()).toBe(true);
  });
});

describe('captureFactsFromTurn — both flags OFF (default)', () => {
  it('makes no LLM call, no resolution, and no writes', async () => {
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'hi', 'hey', { observationDB: db });
    expect(llmMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(inserts).toEqual([]);
  });
});

describe('captureFactsFromTurn — observe ON', () => {
  it('parses observations and inserts one per valid observation with clamped salience', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [],
        observations: [
          { content: 'celebrated getting a Pear offer', salience: 5, kind: 'event' },
          { content: 'felt anxious about visa renewal', salience: 4, kind: 'emotion' },
        ],
      }),
    );
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();

    await captureFactsFromTurn(store, HANDLE, 'I got a Pear offer!', 'lfg 🥹', { observationDB: db });

    expect(llmMock).toHaveBeenCalledOnce();
    expect(appends).toEqual([]); // capture OFF → no fact appends
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toEqual({
      userId: UID,
      obs: { content: 'celebrated getting a Pear offer', salience: 5, kind: 'event' },
      embedding: [0.1, 0.2, 0.3],
    });
    expect(inserts[1].obs).toEqual({
      content: 'felt anxious about visa renewal',
      salience: 4,
      kind: 'emotion',
    });
    // embedObservation called per observation content
    expect(embedMock).toHaveBeenCalledWith('celebrated getting a Pear offer');
    expect(embedMock).toHaveBeenCalledWith('felt anxious about visa renewal');
  });

  it('inserts a null embedding when embedObservation returns null', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    embedMock.mockResolvedValue(null);
    llmMock.mockResolvedValue(
      JSON.stringify({ facts: [], observations: [{ content: 'pulled an all-nighter', salience: 3, kind: 'event' }] }),
    );
    const { store } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].embedding).toBeNull();
  });
});

describe('captureFactsFromTurn — salience clamping & validation', () => {
  it('clamps out-of-range / missing salience to [1,5] (default 3) and skips empty content', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [],
        observations: [
          { content: 'over the top', salience: 9, kind: 'event' }, // → 5
          { content: 'below floor', salience: 0, kind: 'event' }, // → 1
          { content: 'missing salience', kind: 'emotion' }, // → 3
          { content: 'nan salience', salience: 'abc', kind: 'event' }, // → 3
          { content: 'float salience', salience: 4.9, kind: 'event' }, // → 4 (floor to int in range)
          { content: '', salience: 5, kind: 'event' }, // skipped (empty content)
          { content: '   ', salience: 5, kind: 'event' }, // skipped (whitespace-only)
        ],
      }),
    );
    const { store } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db });

    expect(inserts.map((i) => i.obs.content)).toEqual([
      'over the top',
      'below floor',
      'missing salience',
      'nan salience',
      'float salience',
    ]);
    expect(inserts.map((i) => i.obs.salience)).toEqual([5, 1, 3, 3, 4]);
  });

  it('stores kind undefined when kind is not in the allowed set', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [],
        observations: [
          { content: 'bad kind', salience: 3, kind: 'habit' }, // not allowed → undefined
          { content: 'no kind', salience: 3 }, // missing → undefined
          { content: 'good kind', salience: 3, kind: 'relationship' },
        ],
      }),
    );
    const { store } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db });
    expect(inserts[0].obs.kind).toBeUndefined();
    expect(inserts[1].obs.kind).toBeUndefined();
    expect(inserts[2].obs.kind).toBe('relationship');
  });
});

describe('captureFactsFromTurn — capture ON, observe OFF', () => {
  it('appends facts to blocks and inserts no observations', async () => {
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    // Each fact carries a `quote` the source-grounding check finds in the STUDENT text.
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [
          { block: 'academic', fact: 'studies CS, sophomore', quote: 'I study CS' },
          { block: 'interests', fact: 'into hiking and hotpot', quote: 'into hiking and hotpot' },
        ],
        observations: [{ content: 'felt stressed about midterms', salience: 4, kind: 'emotion' }],
      }),
    );
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, "I study CS, sophomore — also into hiking and hotpot", 'y', { observationDB: db });

    expect(appends).toEqual([
      { userId: UID, block: 'academic', content: 'studies CS, sophomore' },
      { userId: UID, block: 'interests', content: 'into hiking and hotpot' },
    ]);
    expect(inserts).toEqual([]); // observe OFF → no inserts
  });
});

describe('captureFactsFromTurn — both ON', () => {
  it('writes facts AND observations and logs both counts', async () => {
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [{ block: 'identity', fact: 'from Shanghai', quote: 'from Shanghai' }],
        observations: [{ content: 'celebrated an offer', salience: 5, kind: 'event' }],
      }),
    );
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, "I'm from Shanghai", 'y', { observationDB: db });

    expect(appends).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    const captureLog = logMock.mock.calls.find((c) => c[1] === 'memory_capture');
    expect(captureLog).toBeDefined();
    expect(captureLog![2]).toMatchObject({ written: 1, observed: 1 });
    // PII: the raw handle must NOT be logged (phone/openid → stdout).
    expect(captureLog![2]).not.toHaveProperty('userId');
  });
});

describe('captureFactsFromTurn — PII consent gate (capture path only)', () => {
  it('capture ON, observe OFF, NOT consented → zero writes AND no LLM call (nothing to write)', async () => {
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    consentMock.mockResolvedValue(false);
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'I study CS', 'y', { observationDB: db });
    expect(llmMock).not.toHaveBeenCalled(); // no consent + no observe → skip extraction entirely
    expect(appends).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it('capture ON, observe ON, NOT consented → facts withheld but observations STILL written (gate must not hurt observe path)', async () => {
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    consentMock.mockResolvedValue(false);
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [{ block: 'academic', fact: 'studies CS', quote: 'I study CS' }],
        observations: [{ content: 'stressed about a midterm', salience: 4, kind: 'emotion' }],
      }),
    );
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'I study CS', 'y', { observationDB: db });
    expect(appends).toEqual([]); // no consent → no fact write
    expect(inserts).toHaveLength(1); // observe path independent of consent
  });
});

describe('captureFactsFromTurn — source-grounding (anti-fabrication)', () => {
  it('drops a fact whose quote is NOT in the student text; keeps one that is', async () => {
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    llmMock.mockResolvedValue(
      JSON.stringify({
        facts: [
          { block: 'academic', fact: 'studies CS', quote: 'I study CS' }, // grounded → kept
          { block: 'identity', fact: 'is from Beijing', quote: 'from Beijing' }, // NOT in text → dropped
          { block: 'interests', fact: 'likes hiking' }, // no quote at all → dropped
        ],
        observations: [],
      }),
    );
    const { store, appends } = makeStore();
    const { db } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'I study CS at USC', 'y', { observationDB: db });
    expect(appends).toEqual([{ userId: UID, block: 'academic', content: 'studies CS' }]);
  });
});

describe('isGroundedInStudentText', () => {
  it('true only when the quote (normalized) appears in the student text', () => {
    expect(isGroundedInStudentText('I study CS', 'well, I Study  CS at USC')).toBe(true); // case + whitespace tolerant
    expect(isGroundedInStudentText('from Beijing', 'I study CS')).toBe(false);
    expect(isGroundedInStudentText('', 'anything')).toBe(false); // empty quote fails closed
    expect(isGroundedInStudentText(undefined, 'anything')).toBe(false);
  });

  it('rejects degenerate short quotes even when present in the text (anti-bypass)', () => {
    expect(isGroundedInStudentText('I', 'I study CS')).toBe(false); // 1-char latin
    expect(isGroundedInStudentText('我', '我是大二')).toBe(false); // single CJK
    expect(isGroundedInStudentText('yes', 'yes I do')).toBe(false); // 3-char filler
    expect(isGroundedInStudentText('我是大二', 'well 我是大二 now')).toBe(true); // 4 chars, substantive
  });
});

describe('captureFactsFromTurn — failure is observable (gap A)', () => {
  it('extractor throws → captureMetrics.failed increments (no longer silent)', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockRejectedValue(new Error('extractor boom'));
    const before = captureMetrics.failed;
    const { store } = makeStore();
    const { db } = makeObservationDB();
    await expect(captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db })).resolves.toBeUndefined();
    expect(captureMetrics.failed).toBe(before + 1);
  });

  it('successful run increments captureMetrics.ok', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(JSON.stringify({ facts: [], observations: [] }));
    const before = captureMetrics.ok;
    const { store } = makeStore();
    const { db } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'hi', 'hey', { observationDB: db });
    expect(captureMetrics.ok).toBe(before + 1);
  });
});

describe('extraction prompt — Observer salience calibration', () => {
  // The real recalibration lives in EXTRACT_SYSTEM (not exported). We can't test
  // the model's judgment through a mock, so we pin the PLUMBING: the system prompt
  // actually handed to the lightweight LLM carries the new "be stingy / drop
  // chit-chat / 1-5 rubric" guidance. If someone reverts the prompt to the noisy
  // version, these assertions fail.
  function systemPromptFromLastCall(): string {
    const [messages] = llmMock.mock.calls[0];
    const system = (messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system',
    );
    return system?.content ?? '';
  }

  it('instructs the LLM to be stingy and default to empty observations', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(JSON.stringify({ facts: [], observations: [] }));
    const { store } = makeStore();
    const { db } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'hi', 'hey', { observationDB: db });

    const sys = systemPromptFromLastCall();
    expect(sys).toMatch(/STINGY/i);
    expect(sys).toContain('"observations":[]');
  });

  it('tells the LLM to DROP greetings, acks, bare questions, and requests to the bot', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(JSON.stringify({ facts: [], observations: [] }));
    const { store } = makeStore();
    const { db } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'hi', 'hey', { observationDB: db });

    const sys = systemPromptFromLastCall();
    expect(sys).toMatch(/DROP/);
    expect(sys.toLowerCase()).toContain('greeting');
    expect(sys.toLowerCase()).toContain('ack');
    // requests to the bot / meta-talk about the AI must be excluded, not logged
    expect(sys.toLowerCase()).toMatch(/asked if you remember|asked for a like|meta-talk about the ai/);
  });

  it('spells out the 1-5 salience rubric (1 trivial → 5 major life event)', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(JSON.stringify({ facts: [], observations: [] }));
    const { store } = makeStore();
    const { db } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'hi', 'hey', { observationDB: db });

    const sys = systemPromptFromLastCall();
    // each rubric level present
    expect(sys).toMatch(/1 = trivial/);
    expect(sys).toMatch(/2 = minor/);
    expect(sys).toMatch(/3 = a normal memorable/);
    expect(sys).toMatch(/4 = significant/);
    expect(sys).toMatch(/5 = highly memorable/);
    // captures the memorable kinds we want to keep
    expect(sys.toLowerCase()).toContain('episodic');
    expect(sys.toLowerCase()).toContain('emotional');
    expect(sys.toLowerCase()).toContain('relationship');
  });

  it('keeps facts extraction + strict-JSON shape unchanged', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(JSON.stringify({ facts: [], observations: [] }));
    const { store } = makeStore();
    const { db } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'hi', 'hey', { observationDB: db });

    const sys = systemPromptFromLastCall();
    // facts contract preserved
    expect(sys).toContain('FACTS');
    expect(sys).toContain('"facts":[]');
    expect(sys).toMatch(/Return STRICT JSON only/);
    // jsonMode still requested
    const [, opts] = llmMock.mock.calls[0];
    expect(opts).toMatchObject({ jsonMode: true });
  });
});

describe('captureFactsFromTurn — robustness', () => {
  it('malformed JSON → no throw, no writes (observe ON)', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue('not json at all <<<');
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await expect(captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db })).resolves.toBeUndefined();
    expect(appends).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it('non-onboarded handle (resolve → null) → skip entirely, no LLM call', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    process.env.MEMORY_CAPTURE_ENABLED = 'true';
    resolveMock.mockResolvedValue(null);
    const { store, appends } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db });
    expect(llmMock).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it('observe ON, no observations key → no inserts, no throw', async () => {
    process.env.GEORGE_OBSERVE_ENABLED = 'true';
    llmMock.mockResolvedValue(JSON.stringify({ facts: [] }));
    const { store } = makeStore();
    const { db, inserts } = makeObservationDB();
    await captureFactsFromTurn(store, HANDLE, 'x', 'y', { observationDB: db });
    expect(inserts).toEqual([]);
  });
});
