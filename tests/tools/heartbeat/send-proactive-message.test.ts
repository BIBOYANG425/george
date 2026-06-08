// tests/tools/heartbeat/send-proactive-message.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSendProactiveTool } from '../../../src/tools/heartbeat/send-proactive-message.js';

describe('send_proactive_message tool', () => {
  it('sends when consent=true and rate limit not exceeded', async () => {
    const sendImessage = vi.fn().mockResolvedValue(undefined);
    const tool = createSendProactiveTool({
      userId: 'u1',
      consentProactive: true,
      tickState: { proactivesSent: 0 },
      sendImessage,
      logAction: vi.fn(),
    });
    const r = await tool.handler({ text: 'hey, you got the BUAD presentation tomorrow', channel: 'imessage' });
    expect(sendImessage).toHaveBeenCalledWith({ to: 'u1', text: 'hey, you got the BUAD presentation tomorrow' });
    expect(r.content[0].text).toMatch(/Sent/);
  });

  it('rejects when consent=false', async () => {
    const tool = createSendProactiveTool({
      userId: 'u1',
      consentProactive: false,
      tickState: { proactivesSent: 0 },
      sendImessage: vi.fn(),
      logAction: vi.fn(),
    });
    await expect(tool.handler({ text: 'ping ping ping', channel: 'imessage' })).rejects.toThrow(/consent/);
  });

  it('rejects when rate limit (1 per tick) exceeded', async () => {
    const tool = createSendProactiveTool({
      userId: 'u1',
      consentProactive: true,
      tickState: { proactivesSent: 1 },
      sendImessage: vi.fn(),
      logAction: vi.fn(),
    });
    await expect(tool.handler({ text: 'ping ping ping', channel: 'imessage' })).rejects.toThrow(/rate limit/);
  });
});
