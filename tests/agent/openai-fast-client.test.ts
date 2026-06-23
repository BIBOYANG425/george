// tests/agent/openai-fast-client.test.ts
//
// The generic OpenAI-format fast client + the doubaoChat delegation onto it.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { openaiChat } from '../../src/agent/openai-fast-client.js';
import { doubaoChat } from '../../src/agent/doubao-client.js';

function mockFetch(status: number, body: unknown) {
  const f = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('openaiChat — generic OpenAI-format client', () => {
  it('POSTs model/messages/max_tokens + extraBody to {baseUrl}/chat/completions with Bearer auth', async () => {
    const f = mockFetch(200, { choices: [{ message: { content: 'hi' } }] });
    const out = await openaiChat(
      { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
      [{ role: 'user', content: 'yo' }],
      { maxTokens: 99, extraBody: { reasoning_effort: 'minimal' } },
    );
    expect(out).toBe('hi');
    expect(f.mock.calls[0][0]).toBe('https://x/v1/chat/completions');
    const init = f.mock.calls[0][1] as any;
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'm', max_tokens: 99, reasoning_effort: 'minimal' });
    expect(body.messages).toEqual([{ role: 'user', content: 'yo' }]);
  });

  it('throws on a non-2xx response', async () => {
    mockFetch(500, 'server boom');
    await expect(openaiChat({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, [])).rejects.toThrow(/500/);
  });

  it('throws (without fetching) when apiKey or model is missing', async () => {
    const f = mockFetch(200, {});
    await expect(openaiChat({ baseUrl: 'https://x/v1', apiKey: '', model: 'm' }, [])).rejects.toThrow(/missing/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('doubaoChat — delegates to openaiChat against Ark', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DOUBAO_API_KEY = 'dk';
    process.env.DOUBAO_MODEL = 'doubao-default';
    delete process.env.DOUBAO_BASE_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('targets Ark with the Doubao key + reasoning_effort, honoring an explicit per-user model', async () => {
    const f = mockFetch(200, { choices: [{ message: { content: 'ok' } }] });
    const out = await doubaoChat([{ role: 'user', content: 'hi' }], { model: 'doubao-explicit', maxTokens: 200 });
    expect(out).toBe('ok');
    const [url, init] = f.mock.calls[0] as [string, any];
    expect(url).toContain('ark.cn-beijing.volces.com');
    expect(init.headers.Authorization).toBe('Bearer dk');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('doubao-explicit'); // explicit model wins over DOUBAO_MODEL
    expect(body.max_tokens).toBe(200);
    expect(body.reasoning_effort).toBeTruthy(); // Ark thinking knob preserved through delegation
  });

  it('defaults to DOUBAO_MODEL when no explicit model is given', async () => {
    const f = mockFetch(200, { choices: [{ message: { content: 'ok' } }] });
    await doubaoChat([{ role: 'user', content: 'hi' }]);
    const body = JSON.parse((f.mock.calls[0][1] as any).body);
    expect(body.model).toBe('doubao-default');
  });
});
