import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySessionStore, SupabaseSessionStore } from '../../src/agent/session-store';

describe('In-memory SessionStore', () => {
  let store: ReturnType<typeof createInMemorySessionStore>;

  beforeEach(() => {
    store = createInMemorySessionStore();
  });

  it('load returns null for unknown user', async () => {
    expect(await store.load('u1')).toBeNull();
  });

  it('save then load round-trips messages', async () => {
    const session = {
      sessionId: 'u1',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hey' },
      ],
      systemContext: { memories: ['user is a sophomore'] },
    };
    await store.save('u1', session);
    const loaded = await store.load('u1');
    expect(loaded?.messages).toEqual(session.messages);
    expect(loaded?.systemContext).toEqual(session.systemContext);
  });

  it('list returns saved session IDs', async () => {
    await store.save('u1', { sessionId: 'u1', messages: [], systemContext: {} });
    await store.save('u2', { sessionId: 'u2', messages: [], systemContext: {} });
    const list = await store.list();
    expect(list.sort()).toEqual(['u1', 'u2']);
  });

  it('delete removes the session', async () => {
    await store.save('u1', { sessionId: 'u1', messages: [], systemContext: {} });
    await store.delete('u1');
    expect(await store.load('u1')).toBeNull();
  });
});
