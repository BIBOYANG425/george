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
  const logs: any[] = [];
  const sentMessages: any[] = [];

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
    deps: {
      profileStore,
      instructionsStore,
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
      loadDueFollowups: vi.fn(async () => []),
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

  it('marks the grounded thread raised in george_notes after a proactive send', async () => {
    process.env.GROUNDED_PROACTIVE_ENABLED = 'true';
    const { deps, profileStore } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;
    const mockLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: '想好选哪个 prof 了吗', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: mockLLM as any });
    const profile = await profileStore.loadProfile('u1');
    expect(profile.george_notes).toMatch(/RAISED_THREAD:/);
  });

  it('does not re-inject a thread that was already raised', async () => {
    process.env.GROUNDED_PROACTIVE_ENABLED = 'true';
    const { deps, profileStore } = makeStores();
    deps.loadRecentMessages = vi.fn(async () => openThreadMessages) as any;

    // First tick raises the thread.
    const sendLLM = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'send_proactive_message', input: { text: '想好选哪个 prof 了吗', channel: 'imessage' } }],
    });
    await runHeartbeat('u1', { ...deps, callLLM: sendLLM as any });
    expect((await profileStore.loadProfile('u1')).george_notes).toMatch(/RAISED_THREAD:/);

    // Second tick on the same open thread should no longer offer it.
    const okLLM = vi.fn().mockResolvedValue({ toolCalls: [{ name: 'heartbeat_ok', input: {} }] });
    await runHeartbeat('u1', { ...deps, callLLM: okLLM as any });
    const userPrompt = okLLM.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).not.toContain('# OPEN THREADS');
  });
});
