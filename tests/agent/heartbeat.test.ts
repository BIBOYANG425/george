// tests/agent/heartbeat.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runHeartbeat } from '../../src/agent/heartbeat.js';
import { createInMemoryCache } from '../../src/memory/kv-cache.js';
import { ProfileStore, EMPTY_PROFILE } from '../../src/memory/profile.js';
import { InstructionsStore } from '../../src/memory/instructions.js';

function makeStores() {
  const cache = createInMemoryCache();
  const profileRows = new Map<string, any>();
  const instructionsRows = new Map<string, string>();
  const followupRows: any[] = [];
  const claimedFollowups: any[] = [];
  const logs: any[] = [];
  const sentMessages: any[] = [];

  // Fake table-backed raised-thread ledger (proactive_raised_threads). Mirrors
  // the DB seam: idempotent insert on (user_id, thread), per-user list.
  const raisedThreadRows: Array<{ user_id: string; thread: string }> = [];
  const raisedThreadDb = {
    async insert(uid: string, t: string) {
      if (!raisedThreadRows.some((r) => r.user_id === uid && r.thread === t)) {
        raisedThreadRows.push({ user_id: uid, thread: t });
      }
    },
    async list(uid: string) {
      return raisedThreadRows.filter((r) => r.user_id === uid).map((r) => r.thread);
    },
  };

  // Fake ObservationDB. Only loadUnconsolidated is exercised by the proactive
  // memory-grounding path; the rest throw so a test that hits them is obvious.
  // `observationRows` is mutable so a test can seed candidate observations.
  const observationRows: any[] = [];
  const loadUnconsolidated = vi.fn(async (uid: string, minSalience: number, limit: number) =>
    observationRows
      .filter((o) => o.user_id === uid && o.salience >= minSalience)
      .slice(0, limit)
      .map((o) => ({ id: o.id, content: o.content, salience: o.salience, kind: o.kind ?? null, created_at: o.created_at })),
  );
  const observationDB = {
    loadUnconsolidated,
    insert: vi.fn(async () => { throw new Error('not used'); }),
    recall: vi.fn(async () => { throw new Error('not used'); }),
    markConsolidated: vi.fn(async () => { throw new Error('not used'); }),
    prune: vi.fn(async () => { throw new Error('not used'); }),
    deleteForUser: vi.fn(async () => { throw new Error('not used'); }),
  };

  const profileStore = new ProfileStore(
    {
      async loadRow(uid) {
        return profileRows.get(uid) ?? null;
      },
      async upsertBlock(uid, block, content) {
        const r = profileRows.get(uid) ?? { ...EMPTY_PROFILE };
        r[block] = content;
        profileRows.set(uid, r);
      },
    },
    cache
  );

  const instructionsStore = new InstructionsStore(
    {
      async load(uid) {
        return instructionsRows.get(uid) ?? null;
      },
      async save(uid, c) {
        instructionsRows.set(uid, c);
      },
    },
    cache
  );

  return {
    profileStore,
    instructionsStore,
    observationRows,
    observationDB,
    loadUnconsolidated,
    deps: {
      profileStore,
      instructionsStore,
      raisedThreadDb,
      observationDB,
      loadConfig: vi.fn(async (uid: string) => ({
        cadence: '12 hours',
        active_hours_start: '09:00',
        active_hours_end: '22:00',
        timezone: 'America/Los_Angeles',
        paused: false,
        consent_proactive_messages: true,
        consent_anomaly_checkin: false,
        last_heartbeat_at: null,
      })),
      loadRecentMessages: vi.fn(async () => []),
      claimDueFollowups: vi.fn(async () => claimedFollowups.map((row) => ({ ...row }))),
      markFollowupsTriggered: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const row = claimedFollowups.find((candidate) => candidate.id === id);
          if (row) row.status = 'triggered';
        }
      }),
      releaseFollowups: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const row = claimedFollowups.find((candidate) => candidate.id === id);
          if (row) row.status = 'pending';
        }
      }),
      sendImessage: vi.fn(async (msg: any) => {
        sentMessages.push(msg);
      }),
      insertFollowup: vi.fn(async (r: any) => {
        followupRows.push(r);
      }),
      writeLog: vi.fn(async (entry: any) => {
        logs.push(entry);
      }),
      updateLastHeartbeatAt: vi.fn(async () => {}),
    },
    profileRows,
    instructionsRows,
    followupRows,
    logs,
    sentMessages,
    claimedFollowups,
    raisedThreadRows,
  };
}

describe('runHeartbeat', () => {
  it('writes a heartbeat_log entry every tick', async () => {
    const { deps, logs } = makeStores();
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'heartbeat_ok', input: {} }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe('ok');
  });

  it('updates last_heartbeat_at on completion', async () => {
    const { deps } = makeStores();
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(deps.updateLastHeartbeatAt).toHaveBeenCalledWith('u1');
  });

  it('records error outcome on LLM failure', async () => {
    const { deps, logs } = makeStores();
    const mockLLM = vi.fn().mockRejectedValue(new Error('LLM unavailable'));
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(logs[0].outcome).toBe('error');
    expect(logs[0].error_message).toMatch(/LLM unavailable/);
  });

  it('claims due followups and marks them triggered after a successful proactive send', async () => {
    const { deps, claimedFollowups } = makeStores();
    claimedFollowups.push({ id: 7, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'how did the interview go?', channel: 'imessage', followup_ids: [7] } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(deps.claimDueFollowups).toHaveBeenCalledTimes(1);
    expect(deps.markFollowupsTriggered).toHaveBeenCalledWith([7]);
    expect(deps.releaseFollowups).not.toHaveBeenCalled();
  });

  it('exposes claimed followup IDs in the prompt for explicit fulfillment', async () => {
    const { deps, claimedFollowups } = makeStores();
    claimedFollowups.push({ id: 15, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(mockLLM.mock.calls[0][0].userPrompt).toContain('[followup_id=15]');
  });

  it('releases referenced followups when NO_REPLY suppresses the proactive send', async () => {
    const previous = process.env.GEORGE_NOREPLY_ENABLED;
    process.env.GEORGE_NOREPLY_ENABLED = 'true';
    try {
      const { deps, claimedFollowups, sentMessages } = makeStores();
      claimedFollowups.push({ id: 10, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
      const mockLLM = vi.fn().mockResolvedValue({
        toolCalls: [{ name: 'send_proactive_message', input: { text: '{{NO_REPLY}} not sending', channel: 'imessage', followup_ids: [10] } }],
      });
      await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
      expect(sentMessages).toEqual([]);
      expect(deps.markFollowupsTriggered).not.toHaveBeenCalled();
      expect(deps.releaseFollowups).toHaveBeenCalledWith([10]);
    } finally {
      if (previous === undefined) delete process.env.GEORGE_NOREPLY_ENABLED;
      else process.env.GEORGE_NOREPLY_ENABLED = previous;
    }
  });

  it('marks only referenced claimed followups and releases the rest after an actual send', async () => {
    const { deps, claimedFollowups } = makeStores();
    claimedFollowups.push(
      { id: 11, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' },
      { id: 12, content: 'ask about housing', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' },
    );
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'how did the interview go?', channel: 'imessage', followup_ids: [11] } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(deps.markFollowupsTriggered).toHaveBeenCalledWith([11]);
    expect(deps.releaseFollowups).toHaveBeenCalledWith([12]);
  });

  it('releases all due followups after an unrelated proactive send', async () => {
    const { deps, claimedFollowups } = makeStores();
    claimedFollowups.push({ id: 13, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'campus closes early today', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(deps.markFollowupsTriggered).not.toHaveBeenCalled();
    expect(deps.releaseFollowups).toHaveBeenCalledWith([13]);
  });

  it('rejects unclaimed followup IDs before sending and releases valid claims', async () => {
    const { deps, claimedFollowups, sentMessages, logs } = makeStores();
    claimedFollowups.push({ id: 14, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'how did the interview go?', channel: 'imessage', followup_ids: [999] } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(sentMessages).toEqual([]);
    expect(deps.markFollowupsTriggered).not.toHaveBeenCalled();
    expect(deps.releaseFollowups).toHaveBeenCalledWith([14]);
    expect(logs[0].error_message).toMatch(/unclaimed followup/i);
  });

  it('releases due followups when the chosen action does not fulfill them', async () => {
    const { deps, claimedFollowups } = makeStores();
    claimedFollowups.push({ id: 9, content: 'ask about interview', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(deps.markFollowupsTriggered).not.toHaveBeenCalled();
    expect(deps.releaseFollowups).toHaveBeenCalledWith([9]);
  });

  it('releases claimed followups when heartbeat handling fails', async () => {
    const { deps, claimedFollowups } = makeStores();
    claimedFollowups.push({ id: 8, content: 'retry me', scheduled_for: '2026-07-01T00:00:00Z', status: 'claimed' });
    const mockLLM = vi.fn().mockRejectedValue(new Error('LLM unavailable'));
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(deps.releaseFollowups).toHaveBeenCalledWith([8]);
    expect(deps.markFollowupsTriggered).not.toHaveBeenCalled();
  });

  it('rejects multiple tool calls before executing any side effects', async () => {
    const { deps, logs, sentMessages } = makeStores();
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [
        { name: 'send_proactive_message', input: { text: 'first', channel: 'imessage' } },
        { name: 'heartbeat_ok', input: {} },
      ],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(sentMessages).toEqual([]);
    expect(logs[0].outcome).toBe('error');
    expect(logs[0].error_message).toMatch(/exactly one tool call/i);
  });
});

describe('runHeartbeat — P4 grounded proactive (flag-gated)', () => {
  // The flag is read from process.env at runtime by runHeartbeat, so the tests
  // toggle it directly and restore it afterward.
  const originalFlag = process.env.GROUNDED_PROACTIVE_ENABLED;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.GROUNDED_PROACTIVE_ENABLED;
    else process.env.GROUNDED_PROACTIVE_ENABLED = originalFlag;
  });

  const openThreadMessages = [
    { role: 'user' as const, content: '想找 writ150 的课', created_at: '2026-06-01T00:00:00Z' },
    {
      role: 'assistant' as const,
      content: '你是想要评分高的 prof 还是 workload 轻的？',
      created_at: '2026-06-01T00:01:00Z',
    },
  ];

  it('does NOT inject the OPEN THREADS section when the flag is OFF', async () => {
    delete process.env.GROUNDED_PROACTIVE_ENABLED;
    const { deps } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    const userPrompt = mockLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).not.toContain('# OPEN THREADS');
  });

  it('keeps the grounded-proactive GUIDANCE out of the system prompt when the flag is OFF', async () => {
    delete process.env.GROUNDED_PROACTIVE_ENABLED;
    const { deps } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    const systemPrompt = mockLLM.mock.calls[0][0].systemPrompt as string;
    expect(systemPrompt).not.toContain('Grounding a proactive in an open thread');
  });

  it('appends the grounded-proactive GUIDANCE to the system prompt only when ON', async () => {
    process.env.GROUNDED_PROACTIVE_ENABLED = 'true';
    const { deps } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    const systemPrompt = mockLLM.mock.calls[0][0].systemPrompt as string;
    expect(systemPrompt).toContain('Grounding a proactive in an open thread');
  });

  it('injects the OPEN THREADS section grounded on an unanswered question when ON', async () => {
    process.env.GROUNDED_PROACTIVE_ENABLED = 'true';
    const { deps } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    const userPrompt = mockLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).toContain('# OPEN THREADS');
    expect(userPrompt).toContain('prof');
  });

  it('records the grounded thread in the proactive_raised_threads table after a proactive send', async () => {
    process.env.GROUNDED_PROACTIVE_ENABLED = 'true';
    const { deps, raisedThreadRows } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: '想好选哪个 prof 了吗', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(raisedThreadRows.filter((r) => r.user_id === 'u1')).toHaveLength(1);
  });

  it('does not re-inject a thread that was already raised (table-backed)', async () => {
    process.env.GROUNDED_PROACTIVE_ENABLED = 'true';
    const { deps, raisedThreadRows } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;

    // First tick raises the thread into the table.
    const sendLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: '想好选哪个 prof 了吗', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: sendLLM as any });
    expect(raisedThreadRows.filter((r) => r.user_id === 'u1')).toHaveLength(1);

    // Second tick on the same open thread should no longer offer it.
    const okLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: okLLM as any });
    const userPrompt = okLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).not.toContain('# OPEN THREADS');
  });
});

describe('runHeartbeat — P6 proactive memory-grounding (flag-gated)', () => {
  // GEORGE_MEMORY_PROACTIVE_ENABLED is read from process.env at runtime; tests
  // toggle it and restore afterward. The optional MEMORY_PROACTIVE_MIN_SALIENCE
  // tunable is also cleaned up between tests.
  const originalFlag = process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;
  const originalSalience = process.env.MEMORY_PROACTIVE_MIN_SALIENCE;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;
    else process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = originalFlag;
    if (originalSalience === undefined) delete process.env.MEMORY_PROACTIVE_MIN_SALIENCE;
    else process.env.MEMORY_PROACTIVE_MIN_SALIENCE = originalSalience;
  });

  const salientObs = (over: Partial<{ id: number; content: string; salience: number }> = {}) => ({
    user_id: 'u1',
    id: over.id ?? 1,
    content: over.content ?? 'student said CSCI 270 final was kicking their ass',
    salience: over.salience ?? 4,
    kind: 'emotion',
    created_at: '2026-06-10T00:00:00Z',
  });

  it('does NOT load observations or change the prompt when the flag is OFF (byte-identical)', async () => {
    delete process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;
    const { deps, observationRows, loadUnconsolidated } = makeStores();
    observationRows.push(salientObs());

    // Build the OFF prompt with the dep wired (the dep is wired in prod, so OFF
    // byte-identical must hold WITH the dep present, not just absent).
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });

    expect(loadUnconsolidated).not.toHaveBeenCalled();
    const userPrompt = mockLLM.mock.calls[0][0].userPrompt as string;
    const systemPrompt = mockLLM.mock.calls[0][0].systemPrompt as string;
    expect(userPrompt).not.toContain('# MEMORIES TO CHECK IN ON');
    expect(systemPrompt).not.toContain('Checking in on a remembered observation');
  });

  it('produces a prompt byte-identical to no-dep when the flag is OFF', async () => {
    delete process.env.GEORGE_MEMORY_PROACTIVE_ENABLED;

    // Run A: dep wired + salient observations present, flag OFF.
    const a = makeStores();
    a.observationRows.push(salientObs());
    const llmA = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...a.deps, callLLM: llmA as any });

    // Run B: NO observationDB dep at all, flag OFF.
    const b = makeStores();
    const { observationDB, ...depsNoObs } = b.deps as any;
    const llmB = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...depsNoObs, callLLM: llmB as any });

    expect(llmA.mock.calls[0][0].userPrompt).toBe(llmB.mock.calls[0][0].userPrompt);
    expect(llmA.mock.calls[0][0].systemPrompt).toBe(llmB.mock.calls[0][0].systemPrompt);
  });

  it('loads salient observations and injects them as candidate memories when ON', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    const { deps, observationRows, loadUnconsolidated } = makeStores();
    observationRows.push(salientObs());
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });

    expect(loadUnconsolidated).toHaveBeenCalledWith('u1', 3, 10); // default salience bar 3
    const userPrompt = mockLLM.mock.calls[0][0].userPrompt as string;
    const systemPrompt = mockLLM.mock.calls[0][0].systemPrompt as string;
    expect(userPrompt).toContain('# MEMORIES TO CHECK IN ON');
    expect(userPrompt).toContain('CSCI 270');
    expect(systemPrompt).toContain('Checking in on a remembered observation');
  });

  it('uses a HIGHER salience bar than recall — filters low-salience observations', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    const { deps, observationRows } = makeStores();
    // salience 2 would pass reactive recall (min 2) but NOT proactive (min 3).
    observationRows.push(salientObs({ id: 7, content: 'minor low-salience note', salience: 2 }));
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    const userPrompt = mockLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).not.toContain('# MEMORIES TO CHECK IN ON');
    expect(userPrompt).not.toContain('minor low-salience note');
  });

  it('honors the MEMORY_PROACTIVE_MIN_SALIENCE override', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    process.env.MEMORY_PROACTIVE_MIN_SALIENCE = '5';
    const { deps, loadUnconsolidated } = makeStores();
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(loadUnconsolidated).toHaveBeenCalledWith('u1', 5, 10);
  });

  it('records surfaced memory keys as raised after a proactive send (mem:<id>)', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    const { deps, observationRows, raisedThreadRows } = makeStores();
    observationRows.push(salientObs({ id: 42 }));
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'CSCI 270 final 考得咋样😋', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(raisedThreadRows.filter((r) => r.user_id === 'u1' && r.thread === 'mem:42')).toHaveLength(1);
  });

  it('does NOT re-surface a memory that was already raised (dedup)', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    const { deps, observationRows, raisedThreadRows } = makeStores();
    observationRows.push(salientObs({ id: 99 }));

    // First tick sends and ledgers mem:99.
    const sendLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'CSCI 270 final 考得咋样😋', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: sendLLM as any });
    expect(raisedThreadRows.filter((r) => r.thread === 'mem:99')).toHaveLength(1);

    // Second tick: same observation still un-consolidated, but already raised, so
    // it must not be re-surfaced.
    const okLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: okLLM as any });
    const userPrompt = okLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).not.toContain('# MEMORIES TO CHECK IN ON');
  });

  it('still respects consent — no proactive send even with memories present', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    const { deps, observationRows, sentMessages } = makeStores();
    observationRows.push(salientObs());
    // No-consent user.
    deps.loadConfig = vi.fn(async () => ({
      cadence: '12 hours',
      active_hours_start: '09:00',
      active_hours_end: '22:00',
      timezone: 'America/Los_Angeles',
      paused: false,
      consent_proactive_messages: false,
      consent_anomaly_checkin: false,
      last_heartbeat_at: null,
    })) as any;
    // Even if the model TRIES to send (memories tempt it), the send tool throws on
    // no-consent; the tick records an error and nothing reaches the user.
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: 'CSCI 270 final 考得咋样😋', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    expect(sentMessages).toHaveLength(0);
  });

  it('does nothing when the observationDB dep is absent even with the flag ON', async () => {
    process.env.GEORGE_MEMORY_PROACTIVE_ENABLED = 'true';
    const { deps, observationRows } = makeStores();
    observationRows.push(salientObs());
    const { observationDB, ...depsNoObs } = deps as any;
    const mockLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...depsNoObs, callLLM: mockLLM as any });
    const userPrompt = mockLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).not.toContain('# MEMORIES TO CHECK IN ON');
  });
});
