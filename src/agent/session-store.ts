// src/agent/session-store.ts
// Agent SDK SessionStore implementation. In-memory adapter for tests; Supabase adapter for runtime.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Session {
  sessionId: string;
  messages: Message[];
  systemContext: Record<string, unknown>;
}

export interface SessionStore {
  load(sessionId: string): Promise<Session | null>;
  save(sessionId: string, session: Session): Promise<void>;
  list(): Promise<string[]>;
  delete(sessionId: string): Promise<void>;
}

export function createInMemorySessionStore(): SessionStore {
  const store = new Map<string, Session>();
  return {
    async load(sessionId) {
      return store.get(sessionId) ?? null;
    },
    async save(sessionId, session) {
      store.set(sessionId, session);
    },
    async list() {
      return Array.from(store.keys());
    },
    async delete(sessionId) {
      store.delete(sessionId);
    },
  };
}

const RECENT_MESSAGES_LIMIT = 20;

export class SupabaseSessionStore implements SessionStore {
  constructor(private supabase: SupabaseClient) {}

  async load(sessionId: string): Promise<Session | null> {
    // Conversation history only. The long-term memory layer lives in
    // user_profiles (loaded separately via ProfileStore in the orchestrator);
    // the old student_memories enrichment here queried columns that don't
    // exist (memory_type/content/user_id) and nothing consumed its output, so
    // it's removed rather than kept as a perpetually-failing query.
    const messagesRes = await this.supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('user_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(RECENT_MESSAGES_LIMIT);

    if (messagesRes.error) {
      console.error('[sessionStore] messages load failed:', messagesRes.error.message);
      return null;
    }

    const messages: Message[] = (messagesRes.data ?? [])
      .reverse()
      .map((m) => ({
        role: m.role as Message['role'],
        content: m.content as string,
      }));

    return {
      sessionId,
      messages,
      systemContext: {},
    };
  }

  async save(sessionId: string, session: Session): Promise<void> {
    const lastMessage = session.messages[session.messages.length - 1];
    if (!lastMessage) return;
    const { error } = await this.supabase.from('messages').insert({
      user_id: sessionId,
      role: lastMessage.role,
      content: lastMessage.content,
      created_at: new Date().toISOString(),
    });
    if (error) {
      // Intentional silent degradation: orchestrator must not crash on
      // DB write failures. A lost message is acceptable signal loss
      // versus a crashed conversation.
      console.error('[sessionStore] save failed:', error.message);
    }
  }

  async list(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select('user_id')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      console.error('[sessionStore] list failed:', error.message);
      return [];
    }
    return Array.from(new Set((data ?? []).map((m) => m.user_id as string)));
  }

  async delete(sessionId: string): Promise<void> {
    await Promise.all([
      this.supabase.from('messages').delete().eq('user_id', sessionId),
      this.supabase.from('student_memories').delete().eq('user_id', sessionId),
    ]);
  }
}

/**
 * Create a Supabase-backed SessionStore. Instantiate ONCE at application
 * startup and share the returned instance across all requests; this function
 * creates a new Supabase client on each call, so per-request invocation would
 * leak connections.
 */
export function createSupabaseSessionStore(): SessionStore {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  return new SupabaseSessionStore(supabase);
}
