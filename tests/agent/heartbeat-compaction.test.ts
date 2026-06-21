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
});
