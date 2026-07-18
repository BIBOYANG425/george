// src/agent/session-store.ts
// Agent SDK SessionStore implementation. In-memory adapter for tests; Supabase adapter for runtime.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  // Optional per-turn telemetry, attached to assistant turns by the orchestrator
  // callers. Persisted into the messages table's existing (previously-unused)
  // columns so the admin dashboard can show cost/model/routing. All optional and
  // best-effort — never required for a turn to save.
  telemetry?: TurnTelemetry;
}

// Captured from the SDK result message at the end of a turn. Written onto the
// assistant `messages` row: `agent` = routed sub-agent, `tokens_used` = total
// tokens, and the richer fields (model, cost, tools, per-model split) ride along
// in the `tool_calls` jsonb column (which the live path never otherwise uses).
export interface TurnTelemetry {
  // NOTE: never written to the `platform` column — that column still carries a
  // CHECK (platform in ('wechat','imessage')) from migration 001, so an
  // out-of-enum value ('web'/'cron') would fail the insert and drop the row.
  // Channel rides in the tool_calls jsonb instead.
  channel?: string;
  subAgent?: string | null;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  costUsd?: number;
  durationMs?: number;
  tools?: string[];
  outcome?: string;
  isError?: boolean;
  perModel?: Record<string, unknown>;
  // Front-line router (GEORGE_ROUTER_ENABLED): the classifier verdict for this turn
  // ('general' → george-lite answered; 'full' → the full agent ran) and the
  // classifier latency in ms. Undefined when the router is off. Ride in tool_calls.
  routeVerdict?: 'general' | 'full';
  classifyMs?: number;
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
  // Cumulative count of user-role messages ever persisted for this session.
  // Unlike load(), this is NOT capped at the recent window, so callers that key
  // a cadence off "every Nth user message" (e.g. the relationship evaluator)
  // get a value that keeps incrementing past the 20-message history limit.
  countUserMessages(sessionId: string): Promise<number>;
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
    async countUserMessages(sessionId) {
      return (store.get(sessionId)?.messages ?? []).filter((m) => m.role === 'user').length;
    },
  };
}

const RECENT_MESSAGES_LIMIT = 20;

export class SupabaseSessionStore implements SessionStore {
  constructor(private supabase: SupabaseClient) {}

  async load(sessionId: string): Promise<Session | null> {
    // Conversation history only. The long-term memory layer lives in
    // user_profiles (loaded separately via ProfileStore in the orchestrator).
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
    // Phase-0 telemetry enrichment: when the caller attached telemetry to an
    // assistant turn, persist it into the existing messages columns (agent /
    // tokens_used / tool_calls / platform). Reactive turns previously dropped
    // these — this is the "fix the dropped usage" wedge. Fully optional.
    const t = lastMessage.telemetry;
    const row: Record<string, unknown> = {
      user_id: sessionId,
      role: lastMessage.role,
      content: lastMessage.content,
      created_at: new Date().toISOString(),
    };
    if (t) {
      // Only the `agent`, `tokens_used`, and `tool_calls` columns are touched.
      // The `platform` column is deliberately left untouched (CHECK constraint).
      if (t.subAgent !== undefined) row.agent = t.subAgent;
      if (typeof t.tokensTotal === 'number') row.tokens_used = t.tokensTotal;
      row.tool_calls = {
        channel: t.channel ?? null,
        model: t.model ?? null,
        costUsd: t.costUsd ?? null,
        tokensIn: t.tokensIn ?? null,
        tokensOut: t.tokensOut ?? null,
        durationMs: t.durationMs ?? null,
        tools: t.tools ?? [],
        outcome: t.outcome ?? null,
        isError: t.isError ?? false,
        perModel: t.perModel ?? null,
        routeVerdict: t.routeVerdict ?? null,
        classifyMs: t.classifyMs ?? null,
      };
    }
    const { error } = await this.supabase.from('messages').insert(row);
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
    await this.supabase.from('messages').delete().eq('user_id', sessionId);
  }

  async countUserMessages(sessionId: string): Promise<number> {
    // head:true returns only the count, no rows — a cheap aggregate. Counts the
    // full history (not the recent-window cap), so the relationship-eval cadence
    // keeps advancing past 20 messages instead of plateauing and misfiring.
    const { count, error } = await this.supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', sessionId)
      .eq('role', 'user');
    if (error) {
      console.error('[sessionStore] countUserMessages failed:', error.message);
      return 0;
    }
    return count ?? 0;
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
