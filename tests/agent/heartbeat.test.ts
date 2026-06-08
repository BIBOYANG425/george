// tests/agent/heartbeat.test.ts
import { describe, it, expect, vi } from 'vitest';
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
