// tests/memory/backfill.test.ts
import { describe, it, expect } from 'vitest';
import { splitGeorgeNotes, planBackfill } from '../../scripts/backfill-memory-consolidation.js';

describe('splitGeorgeNotes', () => {
  it('splits a blob into note / threads / scratchpad', () => {
    const blob =
      'real scratch line\n<!-- relationship_note:start -->\nthey ghost on weekends\n<!-- relationship_note:end -->\nRAISED_THREAD: visa-opt-q';
    const out = splitGeorgeNotes(blob);
    expect(out.note).toBe('they ghost on weekends');
    expect(out.threads).toEqual(['visa-opt-q']);
    expect(out.scratchpad).toBe('real scratch line');
  });
  it('returns empty note/threads + full scratchpad when no fenced data', () => {
    const out = splitGeorgeNotes('just george scratch');
    expect(out.note).toBe('');
    expect(out.threads).toEqual([]);
    expect(out.scratchpad).toBe('just george scratch');
  });
});

describe('planBackfill', () => {
  it('maps student_memories category->block and resolves student_id->user_id', () => {
    const map = new Map([['s1', 'u1']]);
    const plan = planBackfill([{ student_id: 's1', category: 'academic', value: 'studies CS' }], map);
    expect(plan.appends).toEqual([{ userId: 'u1', block: 'academic', addition: 'studies CS' }]);
    expect(plan.unresolved).toEqual([]);
  });
  it('skips (does not lose) rows whose student_id has no user_id', () => {
    const plan = planBackfill([{ student_id: 'x', category: 'academic', value: 'CS' }], new Map());
    expect(plan.appends).toEqual([]);
    expect(plan.unresolved).toEqual(['x']);
  });
  it('routes unknown categories to george_notes', () => {
    const plan = planBackfill(
      [{ student_id: 's1', category: 'misc-banter', value: 'likes boba' }],
      new Map([['s1', 'u1']]),
    );
    expect(plan.appends).toEqual([{ userId: 'u1', block: 'george_notes', addition: 'likes boba' }]);
  });
});
