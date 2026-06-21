import { describe, it, expect } from 'vitest';
import { recordRaisedThread, loadRaisedThreads, type RaisedThreadDB } from '../../src/agent/grounded-proactive.js';

function fakeDb(): RaisedThreadDB & { rows: Array<{ user_id: string; thread: string }> } {
  const rows: Array<{ user_id: string; thread: string }> = [];
  return {
    rows,
    async insert(uid, t) { if (!rows.some(r => r.user_id === uid && r.thread === t)) rows.push({ user_id: uid, thread: t }); },
    async list(uid) { return rows.filter(r => r.user_id === uid).map(r => r.thread); },
  };
}

describe('proactive_raised_threads table seam', () => {
  it('records + dedupes raised threads', async () => {
    const db = fakeDb();
    await recordRaisedThread(db, 'u1', 'visa-opt-question');
    await recordRaisedThread(db, 'u1', 'visa-opt-question');
    expect([...(await loadRaisedThreads(db, 'u1'))]).toEqual(['visa-opt-question']);
  });
  it('scopes by user', async () => {
    const db = fakeDb();
    await recordRaisedThread(db, 'u1', 'a');
    await recordRaisedThread(db, 'u2', 'b');
    expect([...(await loadRaisedThreads(db, 'u1'))]).toEqual(['a']);
  });
});
