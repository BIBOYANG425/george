// tests/tools/heartbeat/add-followup.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAddFollowupTool } from '../../../src/tools/heartbeat/add-followup.js';

describe('add_followup tool', () => {
  it('inserts row with pending status', async () => {
    const insertFollowup = vi.fn().mockResolvedValue(undefined);
    const tool = createAddFollowupTool({
      userId: 'u1',
      insertFollowup,
      logAction: vi.fn(),
    });
    const r = await tool.handler({
      text: 'check on BUAD presentation',
      scheduled_for: '2026-12-10T21:00:00-08:00',
    });
    expect(insertFollowup).toHaveBeenCalledWith({
      userId: 'u1',
      content: 'check on BUAD presentation',
      scheduledFor: '2026-12-10T21:00:00-08:00',
    });
    expect(r.content[0].text).toMatch(/Followup scheduled/);
  });

  it('rejects past scheduled_for', async () => {
    const tool = createAddFollowupTool({
      userId: 'u1',
      insertFollowup: vi.fn(),
      logAction: vi.fn(),
    });
    await expect(
      tool.handler({ text: 'past event check', scheduled_for: '2020-01-01T00:00:00Z' })
    ).rejects.toThrow(/future/);
  });
});
