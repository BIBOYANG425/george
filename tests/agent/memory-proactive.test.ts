// tests/agent/memory-proactive.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  isMemoryProactiveEnabled,
  resolveMemoryProactiveMinSalience,
  memoryKey,
  selectMemoryCandidates,
  renderMemoryProactiveNote,
} from '../../src/agent/memory-proactive.js';
import type { UnconsolidatedObservation } from '../../src/memory/observations.js';

const obs = (over: Partial<UnconsolidatedObservation> = {}): UnconsolidatedObservation => ({
  id: over.id ?? 1,
  content: over.content ?? 'student stressed about CSCI 270 final',
  salience: over.salience ?? 4,
  kind: over.kind ?? 'emotion',
  created_at: over.created_at ?? '2026-06-10T00:00:00Z',
});

describe('isMemoryProactiveEnabled', () => {
  const original = process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;
    else process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = original;
  });

  it('is false when unset (default-OFF)', () => {
    delete process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;
    expect(isMemoryProactiveEnabled()).toBe(false);
  });

  it('is false for any value other than the literal "true"', () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = '1';
    expect(isMemoryProactiveEnabled()).toBe(false);
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'TRUE';
    expect(isMemoryProactiveEnabled()).toBe(false);
  });

  it('is true only for the literal "true"', () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    expect(isMemoryProactiveEnabled()).toBe(true);
  });
});

describe('resolveMemoryProactiveMinSalience', () => {
  const original = process.env.MEMORY_PROACTIVE_MIN_SALIENCE;
  afterEach(() => {
    if (original === undefined) delete process.env.MEMORY_PROACTIVE_MIN_SALIENCE;
    else process.env.MEMORY_PROACTIVE_MIN_SALIENCE = original;
  });

  it('defaults to 3 (higher bar than reactive recall default of 2)', () => {
    delete process.env.MEMORY_PROACTIVE_MIN_SALIENCE;
    expect(resolveMemoryProactiveMinSalience()).toBe(3);
  });

  it('honors a valid override', () => {
    process.env.MEMORY_PROACTIVE_MIN_SALIENCE = '4';
    expect(resolveMemoryProactiveMinSalience()).toBe(4);
  });

  it('clamps to the DB 1..5 CHECK range', () => {
    process.env.MEMORY_PROACTIVE_MIN_SALIENCE = '9';
    expect(resolveMemoryProactiveMinSalience()).toBe(5);
    process.env.MEMORY_PROACTIVE_MIN_SALIENCE = '0';
    expect(resolveMemoryProactiveMinSalience()).toBe(1);
  });

  it('falls back to the default on garbage', () => {
    process.env.MEMORY_PROACTIVE_MIN_SALIENCE = 'abc';
    expect(resolveMemoryProactiveMinSalience()).toBe(3);
  });
});

describe('memoryKey', () => {
  it('derives a stable mem:<id> key disjoint from open-thread gist slugs', () => {
    expect(memoryKey(42)).toBe('mem:42');
    expect(memoryKey(42)).toBe(memoryKey(42));
  });
});

describe('selectMemoryCandidates', () => {
  it('maps observations to mem:<id> candidates', () => {
    const out = selectMemoryCandidates([obs({ id: 5 })], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('mem:5');
    expect(out[0].content).toContain('CSCI 270');
  });

  it('excludes already-raised observations (dedup)', () => {
    const out = selectMemoryCandidates(
      [obs({ id: 5 }), obs({ id: 6, content: 'second memory' })],
      new Set(['mem:5']),
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('mem:6');
  });

  it('drops blank-content observations', () => {
    const out = selectMemoryCandidates([obs({ id: 5, content: '   ' })], new Set());
    expect(out).toHaveLength(0);
  });

  it('caps at 3 candidates even with more available', () => {
    const many = [1, 2, 3, 4, 5].map((id) => obs({ id, content: `memory ${id}` }));
    const out = selectMemoryCandidates(many, new Set());
    expect(out).toHaveLength(3);
  });
});

describe('renderMemoryProactiveNote', () => {
  it('returns empty string for no candidates (prompt unchanged)', () => {
    expect(renderMemoryProactiveNote([])).toBe('');
  });

  it('renders a section naming each candidate memory', () => {
    const note = renderMemoryProactiveNote([
      { key: 'mem:5', content: 'student stressed about CSCI 270 final' },
    ]);
    expect(note).toContain('# MEMORIES TO CHECK IN ON');
    expect(note).toContain('student stressed about CSCI 270 final');
  });
});
