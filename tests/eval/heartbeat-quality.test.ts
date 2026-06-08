// tests/eval/heartbeat-quality.test.ts
// Real-LLM eval suite for the heartbeat handler.
// Skipped when DEEPSEEK_API_KEY is absent (all CI/local runs without the key).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runHeartbeat, HeartbeatLogEntry } from '../../src/agent/heartbeat.js';
import { createDeepSeekClient } from '../../src/agent/llm-clients.js';
import { createInMemoryCache } from '../../src/memory/kv-cache.js';
import { ProfileStore, EMPTY_PROFILE } from '../../src/memory/profile.js';
import { InstructionsStore } from '../../src/memory/instructions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  name: string;
  description?: string;
  profile: Record<string, string>;
  instructions: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; created_at: string }>;
  due_followups: Array<{ id: number; content: string; scheduled_for: string }>;
  expected_outcome: HeartbeatLogEntry['outcome'];
  expected_block?: string;
  _note?: string;
}

const { fixtures } = JSON.parse(
  readFileSync(path.resolve(__dirname, 'fixtures/heartbeat-fixtures.json'), 'utf-8')
) as { fixtures: Fixture[] };

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('heartbeat eval suite', () => {
  let correctCount = 0;
  let totalCount = 0;

  for (const fixture of fixtures) {
    it(`fixture: ${fixture.name}`, async () => {
      const cache = createInMemoryCache();
      const profileRows = new Map<string, Record<string, string>>([
        ['eval-user', { ...EMPTY_PROFILE, ...fixture.profile }],
      ]);
      const instructionsRows = new Map<string, string>([['eval-user', fixture.instructions]]);
      const logs: HeartbeatLogEntry[] = [];

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

      const llm = createDeepSeekClient();

      await runHeartbeat('eval-user', {
        profileStore,
        instructionsStore,
        async loadConfig(_uid) {
          return {
            cadence: '12 hours',
            active_hours_start: '09:00',
            active_hours_end: '22:00',
            timezone: 'America/Los_Angeles',
            paused: false,
            consent_proactive_messages: fixture.name !== 'no_proactive_when_consent_false',
            consent_anomaly_checkin: true,
            last_heartbeat_at: null,
          };
        },
        async loadRecentMessages(_uid, _limit) {
          return fixture.messages;
        },
        async loadDueFollowups(_uid) {
          return fixture.due_followups;
        },
        async sendImessage(_msg) {
          // noop in eval
        },
        async insertFollowup(_row) {
          // noop in eval
        },
        async writeLog(entry) {
          logs.push(entry);
        },
        async updateLastHeartbeatAt(_uid) {
          // noop in eval
        },
        callLLM: llm.call.bind(llm),
      });

      totalCount += 1;
      const actual = logs[0]?.outcome;
      if (actual === fixture.expected_outcome) correctCount += 1;

      expect(actual, `fixture "${fixture.name}": expected ${fixture.expected_outcome}, got ${actual}`).toBe(
        fixture.expected_outcome
      );
    }, 30_000);
  }

  it('overall accuracy >=90%', () => {
    const accuracy = totalCount > 0 ? correctCount / totalCount : 0;
    expect(accuracy, `accuracy ${correctCount}/${totalCount} = ${(accuracy * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(0.9);
  });
});
