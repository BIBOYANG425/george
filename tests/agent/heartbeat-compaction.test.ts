// tests/agent/heartbeat-compaction.test.ts
import { describe, it, expect } from 'vitest';
import { compactProfileIfDue } from '../../src/agent/heartbeat.js';

function bigBlock(n: number) { return Array.from({length:n}, (_,i)=>`fact ${i} about the student`).join('\n'); }

describe('compactProfileIfDue', () => {
  it('compacts over-cap blocks and clears compaction_due when the marker is set', async () => {
    const saved: Array<[string,string,string]> = []; let cleared = false;
    const store = {
      async saveBlock(u: string,b: string,c: string){ saved.push([u,b,c]); },
      async clearCompactionDue(u: string){ cleared = true; },
    };
    const profile = { identity:'', academic: bigBlock(400), interests:'', relationships:'', state:'', george_notes:'', relationship_note:'', compaction_due:'2026-06-21T00:00:00Z' };
    const summarize = async (_block: string, content: string) => content.split('\n').slice(0,5).join('\n'); // shrink
    await compactProfileIfDue(store as any, 'u1', profile as any, summarize);
    expect(cleared).toBe(true);
    const academicSave = saved.find(s => s[1]==='academic');
    expect(academicSave).toBeTruthy();
    expect(academicSave![2].length).toBeLessThan(bigBlock(400).length);
  });

  it('does nothing when compaction_due is not set', async () => {
    let touched = false;
    const store = { async saveBlock(){touched=true;}, async clearCompactionDue(){touched=true;} };
    const profile = { identity:'', academic: bigBlock(400), interests:'', relationships:'', state:'', george_notes:'', relationship_note:'', compaction_due: null };
    await compactProfileIfDue(store as any, 'u1', profile as any, async (_b,c)=>c);
    expect(touched).toBe(false);
  });

  it('only compacts blocks actually over the 4000-char cap', async () => {
    const saved: string[] = [];
    const store = { async saveBlock(_u: string,b: string){ saved.push(b); }, async clearCompactionDue(){} };
    const profile = { identity:'short', academic: bigBlock(400), interests:'', relationships:'', state:'', george_notes:'', relationship_note:'', compaction_due:'2026-06-21T00:00:00Z' };
    await compactProfileIfDue(store as any, 'u1', profile as any, async (_b,c)=>c.slice(0,100));
    expect(saved).toEqual(['academic']); // 'identity' is short, not compacted
  });

  it('does not save (and still clears the marker) when the summary is shorter but still over cap', async () => {
    // Regression: a summarizer that shrinks the block but leaves it >4000 used to
    // hand saveBlock over-cap content, which throws, leaving compaction_due set and
    // re-summarizing the same block on every tick. Now we skip the save, clear the
    // marker, and let the next append re-flag it.
    const saved: Array<[string,string,string]> = []; let cleared = false;
    const store = {
      async saveBlock(u: string,b: string,c: string){ saved.push([u,b,c]); },
      async clearCompactionDue(_u: string){ cleared = true; },
    };
    const original = bigBlock(400); // well over 4000 chars
    const profile = { identity:'', academic: original, interests:'', relationships:'', state:'', george_notes:'', relationship_note:'', compaction_due:'2026-06-21T00:00:00Z' };
    // Shorter than the original but deliberately still over the 4000-char cap.
    const stillOverCap = original.slice(0, original.length - 100);
    expect(stillOverCap.length).toBeGreaterThan(4000);
    const summarize = async () => stillOverCap;
    await expect(compactProfileIfDue(store as any, 'u1', profile as any, summarize)).resolves.toBeUndefined();
    expect(saved.find(s => s[1] === 'academic')).toBeUndefined(); // never handed over-cap content
    expect(cleared).toBe(true); // marker cleared → no infinite re-compaction
  });
});
