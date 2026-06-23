// src/admin/analytics.ts
//
// Read-only analytics queries powering the admin dashboard. All reads go through
// a SupabaseClient (service-role). Aggregation is done in JS — the data volumes
// here are small (hundreds–low-thousands of rows) and JS bucketing avoids
// brittle SQL-via-PostgREST. NOTHING here writes except the explicit
// pause/resume admin actions at the bottom.
//
// Data realities this layer is built around (verified against prod 2026-06-17):
//   - messages.user_id is a TEXT handle (phone/email/web-session/openid).
//   - messages.tokens_used / agent / tool_calls are the telemetry columns the
//     reactive path now enriches (tool_calls jsonb carries model/cost/channel).
//   - students may be keyed off the handle via imessage_id / wechat_open_id /
//     user_id; we build a best-effort lookup across all of them.
//   - user_heartbeat_config.user_id is a uuid; we resolve it via the student.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserControls, getUsageSnapshot, listUserControls, startOfLADayISO } from './user-controls.js';

const DAY_MS = 86_400_000;

// "Today" = LA day (george's users + active-hours are LA-local), not UTC.
function startOfTodayISO(): string {
  return startOfLADayISO();
}

// ── shared row shapes ──────────────────────────────────────────────────────
interface MsgRow {
  id: string;
  user_id: string | null;
  role: string;
  created_at: string;
  agent: string | null;
  tokens_used: number | null;
  tool_calls: any;
}
interface StudentRow {
  id: string;
  user_id: string | null;
  imessage_id: string | null;
  wechat_open_id: string | null;
  name: string | null;
  major: string | null;
  year: string | null;
  onboarding_complete: boolean | null;
  last_active_at: string | null;
}

// Build a handle → student lookup across every key a handle might match.
function indexStudents(students: StudentRow[]): Map<string, StudentRow> {
  const ix = new Map<string, StudentRow>();
  for (const s of students) {
    for (const key of [s.user_id, s.imessage_id, s.wechat_open_id, s.id]) {
      if (key) ix.set(String(key), s);
    }
  }
  return ix;
}

function toolCallsCost(tc: any): number {
  const c = tc && typeof tc === 'object' ? tc.costUsd : null;
  return typeof c === 'number' ? c : 0;
}
function toolCallsChannel(tc: any): string | null {
  return tc && typeof tc === 'object' && typeof tc.channel === 'string' ? tc.channel : null;
}

// ── OVERVIEW (today + totals + telemetry coverage) ─────────────────────────
export async function getOverview(sb: SupabaseClient) {
  const today = startOfTodayISO();
  const sevenAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();

  const headCount = async (table: string, mod?: (q: any) => any) => {
    let q = sb.from(table).select('*', { count: 'exact', head: true });
    if (mod) q = mod(q);
    const { count } = await q;
    return count ?? 0;
  };

  // Today's assistant rows carry the telemetry — pull them to sum tokens/cost.
  const { data: todayAssistants } = await sb
    .from('messages')
    .select('tokens_used, tool_calls, agent')
    .gte('created_at', today)
    .eq('role', 'assistant');

  let tokensToday = 0;
  let costToday = 0;
  for (const r of todayAssistants ?? []) {
    if (typeof r.tokens_used === 'number') tokensToday += r.tokens_used;
    costToday += toolCallsCost(r.tool_calls);
  }

  const [
    messagesTotal,
    messagesToday,
    userMsgsToday,
    studentsTotal,
    eventsTotal,
    activeEvents,
    proactiveTotal,
    heartbeatTotal,
    msgsWithTokens,
    assistantTotal,
  ] = await Promise.all([
    headCount('messages'),
    headCount('messages', (q) => q.gte('created_at', today)),
    headCount('messages', (q) => q.gte('created_at', today).eq('role', 'user')),
    headCount('students'),
    headCount('events'),
    headCount('events', (q) => q.eq('status', 'active')),
    headCount('proactive_log'),
    headCount('heartbeat_log'),
    headCount('messages', (q) => q.not('tokens_used', 'is', null)),
    // Only assistant turns ever carry tokens_used, so coverage must divide by
    // assistant rows — dividing by ALL messages structurally caps it near 50%.
    headCount('messages', (q) => q.eq('role', 'assistant')),
  ]);

  // Active-today / active-7d users from distinct handles in messages. Cap raised
  // to 50k so a busy 7-day window isn't truncated (DESC order would drop the
  // oldest rows and undercount active7d). countActive flags if we still hit it.
  const ACTIVE_CAP = 50000;
  const { data: recentHandles } = await sb
    .from('messages')
    .select('user_id, created_at')
    .gte('created_at', sevenAgo)
    .order('created_at', { ascending: false })
    .limit(ACTIVE_CAP);
  const activeToday = new Set<string>();
  const active7d = new Set<string>();
  for (const r of recentHandles ?? []) {
    if (!r.user_id) continue;
    active7d.add(r.user_id);
    if (r.created_at >= today) activeToday.add(r.user_id);
  }

  return {
    today: {
      messages: messagesToday,
      questions: userMsgsToday,
      activeUsers: activeToday.size,
      tokens: tokensToday,
      costUsd: Number(costToday.toFixed(4)),
    },
    totals: {
      messages: messagesTotal,
      students: studentsTotal,
      events: eventsTotal,
      activeEvents,
      proactiveSent: proactiveTotal,
      heartbeats: heartbeatTotal,
      activeUsers7d: active7d.size,
    },
    telemetry: {
      messagesWithTokens: msgsWithTokens,
      assistantMessages: assistantTotal,
      // Coverage = token-bearing rows / assistant rows (only assistant turns can
      // carry tokens). Can now legitimately reach 100% as the reactive path fills in.
      coveragePct: assistantTotal ? Math.round((msgsWithTokens / assistantTotal) * 100) : 0,
      truncated: (recentHandles?.length ?? 0) >= ACTIVE_CAP,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ── TIMESERIES (daily message volume) ──────────────────────────────────────
export async function getTimeseries(sb: SupabaseClient, days = 14) {
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { data } = await sb
    .from('messages')
    .select('created_at, role')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(10000);

  const buckets = new Map<string, { user: number; assistant: number; total: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    buckets.set(d, { user: 0, assistant: 0, total: 0 });
  }
  for (const r of data ?? []) {
    const d = String(r.created_at).slice(0, 10);
    const b = buckets.get(d);
    if (!b) continue;
    b.total++;
    if (r.role === 'user') b.user++;
    else if (r.role === 'assistant') b.assistant++;
  }
  return Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }));
}

// ── LIVE FEED (recent turns — "what are users asking right now") ───────────
export async function getLiveFeed(sb: SupabaseClient, opts: { limit?: number; onlyToday?: boolean } = {}) {
  const limit = Math.min(opts.limit ?? 60, 200);
  let q = sb
    .from('messages')
    .select('id, user_id, role, content, created_at, agent, tokens_used, tool_calls')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (opts.onlyToday) q = q.gte('created_at', startOfTodayISO());
  const { data } = await q;

  const students = await loadStudents(sb);
  const ix = indexStudents(students);

  return (data ?? []).map((m: any) => {
    const s = m.user_id ? ix.get(String(m.user_id)) : undefined;
    return {
      id: m.id,
      userId: m.user_id,
      handleShort: m.user_id ? maskHandle(m.user_id) : '—',
      who: s?.name || (s?.major ? `${s.major} ${s.year ?? ''}`.trim() : null),
      role: m.role,
      content: m.content,
      channel: toolCallsChannel(m.tool_calls),
      agent: m.agent,
      tokens: m.tokens_used,
      costUsd: toolCallsCost(m.tool_calls) || null,
      createdAt: m.created_at,
    };
  });
}

// ── AGENT / CHANNEL distributions ──────────────────────────────────────────
export async function getDistributions(sb: SupabaseClient) {
  const { data } = await sb
    .from('messages')
    .select('agent, tool_calls, role')
    .limit(10000);
  const agents = new Map<string, number>();
  const channels = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const r of data ?? []) {
    if (r.agent) agents.set(r.agent, (agents.get(r.agent) ?? 0) + 1);
    const ch = toolCallsChannel(r.tool_calls);
    if (ch) channels.set(ch, (channels.get(ch) ?? 0) + 1);
    // Tool-usage distribution from the telemetry jsonb. Works in single-agent
    // mode (where there is no routed sub-agent to label) — counts each tool the
    // turn invoked. One increment per (turn, tool).
    const tc = r.tool_calls;
    if (tc && typeof tc === 'object' && Array.isArray(tc.tools)) {
      for (const t of tc.tools) if (t) tools.set(String(t), (tools.get(String(t)) ?? 0) + 1);
    }
  }
  const toArr = (m: Map<string, number>) =>
    Array.from(m.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  return { agents: toArr(agents), channels: toArr(channels), tools: toArr(tools) };
}

// ── USERS list ─────────────────────────────────────────────────────────────
async function loadStudents(sb: SupabaseClient): Promise<StudentRow[]> {
  const { data } = await sb
    .from('students')
    .select('id, user_id, imessage_id, wechat_open_id, name, major, year, onboarding_complete, last_active_at')
    .limit(2000);
  return (data ?? []) as StudentRow[];
}

export async function getUsers(sb: SupabaseClient, limit = 100) {
  const { data: msgs } = await sb
    .from('messages')
    .select('user_id, role, created_at, tokens_used, tool_calls')
    .order('created_at', { ascending: false })
    .limit(10000);

  const students = await loadStudents(sb);
  const ix = indexStudents(students);

  const { data: hbConfigs } = await sb
    .from('user_heartbeat_config')
    .select('user_id, paused, pause_until, last_heartbeat_at');
  const hbByKey = new Map<string, any>();
  for (const h of hbConfigs ?? []) hbByKey.set(String(h.user_id), h);

  type Agg = {
    userId: string;
    messages: number;
    questions: number;
    tokens: number;
    costUsd: number;
    lastActive: string;
    firstSeen: string;
  };
  const agg = new Map<string, Agg>();
  for (const m of msgs ?? []) {
    if (!m.user_id) continue;
    const key = String(m.user_id);
    let a = agg.get(key);
    if (!a) {
      a = { userId: key, messages: 0, questions: 0, tokens: 0, costUsd: 0, lastActive: m.created_at, firstSeen: m.created_at };
      agg.set(key, a);
    }
    a.messages++;
    if (m.role === 'user') a.questions++;
    if (typeof m.tokens_used === 'number') a.tokens += m.tokens_used;
    a.costUsd += toolCallsCost(m.tool_calls);
    if (m.created_at > a.lastActive) a.lastActive = m.created_at;
    if (m.created_at < a.firstSeen) a.firstSeen = m.created_at;
  }

  const controlsStore = listUserControls();
  const rows = Array.from(agg.values())
    .sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1))
    .slice(0, limit)
    .map((a) => {
      const s = ix.get(a.userId);
      const ctrl = controlsStore[a.userId];
      const hb = hbByKey.get(a.userId) || (s?.user_id ? hbByKey.get(String(s.user_id)) : undefined) || (s ? hbByKey.get(String(s.id)) : undefined);
      return {
        userId: a.userId,
        handleShort: maskHandle(a.userId),
        name: s?.name ?? null,
        major: s?.major ?? null,
        year: s?.year ?? null,
        onboarded: s?.onboarding_complete ?? false,
        hasStudent: !!s,
        messages: a.messages,
        questions: a.questions,
        tokens: a.tokens,
        costUsd: Number(a.costUsd.toFixed(4)),
        lastActive: a.lastActive,
        firstSeen: a.firstSeen,
        heartbeat: hb ? { paused: !!hb.paused, lastAt: hb.last_heartbeat_at ?? null } : null,
        control: ctrl
          ? { modelOverride: ctrl.modelOverride ?? null, mainModel: ctrl.mainModel ?? null, emotionalModel: ctrl.emotionalModel ?? null, dailyMessageLimit: ctrl.dailyMessageLimit ?? null, blocked: !!ctrl.blocked }
          : null,
      };
    });

  return rows;
}

// ── USER detail (drill-down) ───────────────────────────────────────────────
export async function getUserDetail(sb: SupabaseClient, userId: string) {
  const [{ data: convo }, students, { data: profileRows }] = await Promise.all([
    sb
      .from('messages')
      .select('id, role, content, created_at, agent, tokens_used, tool_calls')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(500),
    loadStudents(sb),
    sb.from('user_profiles').select('*').eq('user_id', userId),
  ]);

  const ix = indexStudents(students);
  const student = ix.get(userId) ?? null;

  // profile may be keyed by the student uuid rather than the raw handle
  let profile = (profileRows ?? [])[0] ?? null;
  if (!profile && student?.user_id) {
    const { data } = await sb.from('user_profiles').select('*').eq('user_id', student.user_id);
    profile = (data ?? [])[0] ?? null;
  }

  // heartbeat config (try handle, then student uuid)
  let hb: any = null;
  for (const key of [userId, student?.user_id, student?.id].filter(Boolean)) {
    const { data } = await sb.from('user_heartbeat_config').select('*').eq('user_id', key as string).maybeSingle();
    if (data) { hb = data; break; }
  }

  let cost = 0;
  let tokens = 0;
  for (const m of convo ?? []) {
    if (typeof m.tokens_used === 'number') tokens += m.tokens_used;
    cost += toolCallsCost(m.tool_calls);
  }

  const controls = getUserControls(userId);
  const usage = await getUsageSnapshot(userId);

  return {
    userId,
    handleShort: maskHandle(userId),
    student,
    profile,
    heartbeat: hb,
    controls,
    usage,
    stats: { messages: (convo ?? []).length, tokens, costUsd: Number(cost.toFixed(4)) },
    conversation: (convo ?? []).map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      agent: m.agent,
      tokens: m.tokens_used,
      channel: toolCallsChannel(m.tool_calls),
      costUsd: toolCallsCost(m.tool_calls) || null,
      createdAt: m.created_at,
    })),
  };
}

// ── SYSTEM health ──────────────────────────────────────────────────────────
export async function getSystemHealth(sb: SupabaseClient) {
  const { data: hbLog } = await sb
    .from('heartbeat_log')
    .select('user_id, fired_at, duration_ms, outcome, error_message')
    .order('fired_at', { ascending: false })
    .limit(20);

  const outcomes = new Map<string, number>();
  for (const h of hbLog ?? []) outcomes.set(h.outcome, (outcomes.get(h.outcome) ?? 0) + 1);

  // Denominator is assistant rows: only assistant turns carry tokens_used/agent,
  // so dividing by ALL messages would structurally cap coverage near 50%.
  const { count: assistantMsgs } = await sb
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'assistant');
  const { count: withTokens } = await sb
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'assistant')
    .not('tokens_used', 'is', null);
  const { count: withAgent } = await sb
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'assistant')
    .not('agent', 'is', null);

  const { data: hbCfgs } = await sb
    .from('user_heartbeat_config')
    .select('user_id, paused, last_heartbeat_at, consent_proactive_messages');

  const denom = assistantMsgs ?? 0;
  return {
    telemetryCoverage: {
      total: denom,
      withTokens: withTokens ?? 0,
      withAgent: withAgent ?? 0,
      tokensPct: denom ? Math.round(((withTokens ?? 0) / denom) * 100) : 0,
      agentPct: denom ? Math.round(((withAgent ?? 0) / denom) * 100) : 0,
    },
    heartbeat: {
      recentOutcomes: Array.from(outcomes.entries()).map(([outcome, count]) => ({ outcome, count })),
      configured: (hbCfgs ?? []).length,
      paused: (hbCfgs ?? []).filter((h) => h.paused).length,
      consented: (hbCfgs ?? []).filter((h) => h.consent_proactive_messages).length,
      recent: (hbLog ?? []).slice(0, 10),
    },
  };
}

// ── ADMIN ACTIONS (the only writes) ────────────────────────────────────────
export async function setHeartbeatPaused(sb: SupabaseClient, userId: string, paused: boolean) {
  // Resolve the heartbeat config key (handle, or the student's uuid).
  const students = await loadStudents(sb);
  const ix = indexStudents(students);
  const student = ix.get(userId);
  const candidates = [userId, student?.user_id, student?.id].filter(Boolean) as string[];
  for (const key of candidates) {
    const { data } = await sb.from('user_heartbeat_config').select('user_id').eq('user_id', key).maybeSingle();
    if (data) {
      const { error } = await sb
        .from('user_heartbeat_config')
        .update({ paused, pause_until: null, updated_at: new Date().toISOString() })
        .eq('user_id', key);
      return { ok: !error, key, error: error?.message };
    }
  }
  return { ok: false, error: 'no heartbeat config row for this user' };
}

// ── helpers ────────────────────────────────────────────────────────────────
// Keep handles partly masked in list/feed views (they're phone numbers / emails
// = direct PII). The drill-down still resolves the full handle server-side, but
// the rendered list never shows the full identifier.
export function maskHandle(handle: string): string {
  const h = String(handle);
  if (h.includes('@')) {
    const [u, d] = h.split('@');
    return `${u.slice(0, 2)}***@${d}`;
  }
  if (h.length <= 6) return h.slice(0, 2) + '***';
  return h.slice(0, 4) + '***' + h.slice(-3);
}
