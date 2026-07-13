// Vendored from imessage-agent-observability-boilerplate (packages/core/src/index.ts).
// @agent-obs/core — dependency-free ingestion SDK. Do not add imports here;
// keep it standalone so it can never pull deps into george's hot path.
// Source: github.com/patrick201936395/imessage-agent-observability-boilerplate

// @agent-obs/core — ingestion SDK for chat-agent observability.
//
// Wrap your agent's message loop with an adapter (see @agent-obs/adapter-*)
// and call obs.logMessage() / obs.upsertContact(). Design (battle-tested on a
// live iMessage agent):
//   • Non-blocking: calls enqueue and return — the reply path never awaits a write.
//   • Bounded: fixed-concurrency pool + capped backlog; sheds under flood
//     rather than exhausting sockets. Observability must never hurt the agent.
//   • Idempotent: unique external_id → provider redelivery can't double-count.
//   • Sticky channel: transports are flaky per-message on some providers
//     (e.g. cloud iMessage omits sender.service sometimes). Learn the channel
//     from any confident message, persist it, NEVER downgrade to "unknown".

export interface NormalizedMessage {
  conversationId: string;
  direction: "inbound" | "outbound";
  platform: string;
  /** Sub-transport within the platform (iMessage/SMS/RCS on Apple; usually = platform). */
  channel?: string;
  contentType?: string;
  text?: string;
  mediaUrl?: string;
  externalId?: string;
  timestamp?: Date;
  senderName?: string;
  metadata?: Record<string, unknown>;
}

/** One per messaging platform: maps a native provider message → NormalizedMessage. */
export interface PlatformAdapter<TNative = unknown> {
  platform: string;
  toEvent(native: TNative): NormalizedMessage | null;
}

export interface ObservabilityConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  agentId?: string;
  maxInflight?: number;
  maxQueue?: number;
  requestTimeoutMs?: number;
  onError?: (context: string, error: unknown) => void;
}

export interface Observability {
  /** Enqueue one message row (non-blocking). Applies the sticky-channel rule. */
  logMessage(m: NormalizedMessage): void;
  /** Upsert the contact roster (throttled to ≤1/min per handle after first sighting). */
  upsertContact(c: { handle: string; displayName?: string; platform?: string; channel?: string; at?: Date }): void;
  /** Channel for an outbound send: memory cache → persisted contact → "unknown". */
  resolveOutboundChannel(handle: string): Promise<string>;
  /** Learn a channel from an inbound hint; returns the resolved channel. */
  channelFor(handle: string, hint?: unknown): string;
  /** Warm the channel cache from persisted contacts (call once at startup). */
  seedChannelCache(): Promise<void>;
  /** Reflect an opt-out/opt-in into the roster (bypasses the upsert throttle). */
  setContactOptOut(handle: string, optedOut: boolean): void;
  /** True if the persisted contact has opted out (for send-path guards). */
  isOptedOut(handle: string): Promise<boolean>;
}

export function createObservability(cfg: ObservabilityConfig): Observability {
  const agentId = cfg.agentId ?? "default";
  const MAX_INFLIGHT = cfg.maxInflight ?? 8;
  const MAX_QUEUE = cfg.maxQueue ?? 5_000;
  const TIMEOUT = cfg.requestTimeoutMs ?? 5_000;
  const onError = cfg.onError ?? ((ctx, err) => console.error(`[agent-obs] ${ctx}:`, err));

  const H = {
    apikey: cfg.serviceRoleKey,
    authorization: `Bearer ${cfg.serviceRoleKey}`,
    "content-type": "application/json",
  } as const;

  // ---- bounded worker pool -------------------------------------------------
  type Task = () => Promise<void>;
  const queue: Task[] = [];
  let inflight = 0;
  let shed = 0;

  function pump(): void {
    while (inflight < MAX_INFLIGHT && queue.length > 0) {
      const task = queue.shift()!;
      inflight++;
      task()
        .catch(() => {})
        .finally(() => {
          inflight--;
          pump();
        });
    }
  }

  function enqueue(task: Task): void {
    if (queue.length >= MAX_QUEUE) {
      shed++;
      if (shed % 100 === 1) onError("queue", new Error(`saturated — ${shed} writes shed`));
      return;
    }
    queue.push(task);
    pump();
  }

  async function post(table: string, body: unknown, prefer: string, idempotent: boolean): Promise<void> {
    const attempt = async (): Promise<void> => {
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...H, prefer },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      // 409 = duplicate external_id — expected on redelivery, treat as ok.
      if (!res.ok && res.status !== 409) throw new Error(`${res.status} ${await res.text()}`);
    };
    try {
      await attempt();
    } catch (err) {
      if (!idempotent) return onError(table, err);
      try {
        await attempt();
      } catch (err2) {
        onError(`${table} (after retry)`, err2);
      }
    }
  }

  // ---- sticky channel ------------------------------------------------------
  const channelCache = new Map<string, string>();

  function confident(ch: unknown): string | null {
    return typeof ch === "string" && ch && ch !== "unknown" ? ch : null;
  }

  function channelFor(handle: string, hint?: unknown): string {
    const h = confident(hint);
    if (h) {
      if (channelCache.size > 50_000) channelCache.clear();
      channelCache.set(handle, h);
      return h;
    }
    return channelCache.get(handle) ?? "unknown";
  }

  async function fetchContact(handle: string): Promise<{ channel?: string; opted_out?: string } | null> {
    try {
      const res = await fetch(
        `${cfg.supabaseUrl}/rest/v1/obs_contacts?agent_id=eq.${encodeURIComponent(agentId)}&handle=eq.${encodeURIComponent(handle)}&select=channel,opted_out`,
        { headers: H, signal: AbortSignal.timeout(TIMEOUT) },
      );
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{ channel?: string; opted_out?: string }>;
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  // ---- contact upsert throttle ---------------------------------------------
  const lastContactWrite = new Map<string, number>();

  return {
    logMessage(m) {
      const channel = channelFor(m.conversationId, m.channel);
      const row: Record<string, unknown> = {
        agent_id: agentId,
        conversation_id: m.conversationId,
        direction: m.direction,
        platform: m.platform,
        channel,
        content_type: m.contentType ?? "text",
        text: m.text ?? null,
        media_url: m.mediaUrl ?? null,
        external_id: m.externalId ?? null,
        metadata: m.metadata ?? {},
      };
      if (m.timestamp) row.created_at = m.timestamp.toISOString();
      enqueue(() => post("obs_messages", row, "return=minimal", Boolean(m.externalId)));
    },

    upsertContact(c) {
      const now = Date.now();
      const last = lastContactWrite.get(c.handle);
      if (last && now - last < 60_000) return; // first sighting always writes
      lastContactWrite.set(c.handle, now);
      if (lastContactWrite.size > 50_000) lastContactWrite.clear();

      const iso = (c.at ?? new Date()).toISOString();
      const row: Record<string, unknown> = {
        agent_id: agentId,
        handle: c.handle,
        last_seen: iso,
        last_message_at: iso,
      };
      if (c.displayName) row.display_name = c.displayName;
      if (c.platform) row.platform = c.platform;
      const ch = confident(c.channel); // sticky rule: never downgrade to unknown
      if (ch) row.channel = ch;
      enqueue(() => post("obs_contacts", row, "resolution=merge-duplicates,return=minimal", true));
    },

    channelFor,

    async resolveOutboundChannel(handle) {
      const cached = channelCache.get(handle);
      if (cached) return cached;
      const contact = await fetchContact(handle);
      const ch = confident(contact?.channel);
      if (ch) channelCache.set(handle, ch);
      return ch ?? "unknown";
    },

    async seedChannelCache() {
      try {
        const res = await fetch(
          `${cfg.supabaseUrl}/rest/v1/obs_contacts?agent_id=eq.${encodeURIComponent(agentId)}&select=handle,channel`,
          { headers: H, signal: AbortSignal.timeout(TIMEOUT) },
        );
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{ handle: string; channel?: string }>;
        for (const r of rows) {
          const ch = confident(r.channel);
          if (ch) channelCache.set(r.handle, ch);
        }
      } catch {
        /* best-effort */
      }
    },

    setContactOptOut(handle, optedOut) {
      const row: Record<string, unknown> = {
        agent_id: agentId,
        handle,
        opted_out: optedOut ? new Date().toISOString() : null,
        last_seen: new Date().toISOString(),
      };
      enqueue(() => post("obs_contacts", row, "resolution=merge-duplicates,return=minimal", true));
    },

    async isOptedOut(handle) {
      const contact = await fetchContact(handle);
      return Boolean(contact?.opted_out);
    },
  };
}
