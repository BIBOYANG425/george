// tests/tools/heartbeat/send-proactive-message.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
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

  describe('{{NO_REPLY}} handling (P1)', () => {
    const prev = process.env.GEORGE_NOREPLY_ENABLED;
    afterEach(() => {
      if (prev === undefined) delete process.env.GEORGE_NOREPLY_ENABLED;
      else process.env.GEORGE_NOREPLY_ENABLED = prev;
    });

    it('always strips a stray NO_REPLY token from outgoing text (never ships the marker)', async () => {
      delete process.env.GEORGE_NOREPLY_ENABLED; // even with the opt-out OFF
      const sendImessage = vi.fn().mockResolvedValue(undefined);
      const tickState = { proactivesSent: 0 };
      const tool = createSendProactiveTool({
        userId: 'u1', consentProactive: true, tickState, sendImessage, logAction: vi.fn(),
      });
      await tool.handler({ text: 'meet at noon by leavey {{NO_REPLY}}', channel: 'imessage' });
      expect(sendImessage).toHaveBeenCalledTimes(1);
      const sent = sendImessage.mock.calls[0][0].text as string;
      expect(sent).not.toContain('{{NO_REPLY}}');
      expect(sent).toContain('meet at noon by leavey');
      expect(tickState.proactivesSent).toBe(1);
    });

    it('suppresses the send when the opt-out is ON and the model declines via {{NO_REPLY}}', async () => {
      process.env.GEORGE_NOREPLY_ENABLED = 'true';
      const sendImessage = vi.fn().mockResolvedValue(undefined);
      const tickState = { proactivesSent: 0 };
      const tool = createSendProactiveTool({
        userId: 'u1', consentProactive: true, tickState, sendImessage, logAction: vi.fn(),
      });
      const r = await tool.handler({ text: 'nah, leave it {{NO_REPLY}}', channel: 'imessage' });
      expect(sendImessage).not.toHaveBeenCalled();
      expect(tickState.proactivesSent).toBe(0); // declines don't burn the per-tick budget
      expect(r.content[0].text).toMatch(/Declined/);
    });

    it('suppresses when stripping leaves nothing to say', async () => {
      delete process.env.GEORGE_NOREPLY_ENABLED;
      const sendImessage = vi.fn().mockResolvedValue(undefined);
      const tool = createSendProactiveTool({
        userId: 'u1', consentProactive: true, tickState: { proactivesSent: 0 }, sendImessage, logAction: vi.fn(),
      });
      const r = await tool.handler({ text: '{{NO_REPLY}}', channel: 'imessage' });
      expect(sendImessage).not.toHaveBeenCalled();
      expect(r.content[0].text).toMatch(/Declined/);
    });
  });
});
