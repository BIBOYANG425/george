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
import { resolveProfileKey, resolveHeartbeatConfig, isMissingTableError } from './resolve.js';
import { distressSignals, crisisRadarEnabled } from './crisis.js';

const DAY_MS = 86_400_000;

// "Today" = LA day (george's users + active-hours are LA-local), not UTC.
function startOfTodayISO(): string {
  return startOfLADayISO();
}

// The America/Los_Angeles calendar day (YYYY-MM-DD) an instant falls on. DST-correct:
// the day boundary is LA midnight, which shifts an hour across PST/PDT — so we ask Intl
// for the LA wall-clock date directly instead of slicing the UTC ISO string (which would
// misfile the 7-8h window after UTC midnight onto the wrong LA day — the same reason
// startOfLADayISO exists). Exported so the bucketing is unit-testable without the DB.
const LA_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function laDayKey(instant: string | number | Date): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = LA_DAY_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
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
interface ObservationRow {
  id: number;
  content: string;
  salience: number;
  kind: string | null;
  created_at: string;
  consolidated_at: string | null;
}
interface DistressHit {
  handleShort: string;
  source: 'message' | 'observation';
  signals: string[];
  snippet: string;
  createdAt: string;
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
    // Numerator matches getSystemHealth: only assistant turns carry tokens_used, so
    // the token-bearing count must be scoped to assistant rows too — otherwise the
    // fraction's numerator and denominator count different row populations.
    headCount('messages', (q) => q.eq('role', 'assistant').not('tokens_used', 'is', null)),
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

  // Bucket by LA-local calendar day (matching the overview cards / startOfLADayISO),
  // NOT the raw UTC date — slicing created_at would push the 7-8h window after UTC
  // midnight onto the wrong day. The bucket keys walk back from today's LA date using
  // UTC arithmetic on the pure calendar date (DST-free: every UTC day is exactly 24h),
  // so we always get `days` sequential LA days with no gap/dup across a DST boundary.
  const todayKey = laDayKey(Date.now());
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const anchor = Date.UTC(ty, tm - 1, td);
  const buckets = new Map<string, { user: number; assistant: number; total: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(anchor - i * DAY_MS).toISOString().slice(0, 10);
    buckets.set(d, { user: 0, assistant: 0, total: 0 });
  }
  for (const r of data ?? []) {
    const b = buckets.get(laDayKey(r.created_at));
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
  // Windowed over the most-recent 10k messages (DESC + limit), so the distribution
  // reflects current behavior rather than a truncated arbitrary slice. The dashboard
  // labels these panels "近 10k 条消息" to match.
  const { data } = await sb
    .from('messages')
    .select('agent, tool_calls, role')
    .order('created_at', { ascending: false })
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
          ? { modelOverride: ctrl.modelOverride ?? null, emotionalModel: ctrl.emotionalModel ?? null, dailyMessageLimit: ctrl.dailyMessageLimit ?? null, blocked: !!ctrl.blocked }
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

  // Observations (P6 user_observations): keyed by the SAME profile uuid as
  // user_profiles. Prefer the uuid the profile was actually found under
  // (profile.user_id) so observations and the profile blocks always agree; fall
  // back to resolveProfileKey (handle→uuid bridge) then the student uuid. Using
  // profile.user_id matters when the dashboard handle is a students.id-style uuid:
  // resolveProfileKey would pass it through unchanged and query the wrong key,
  // silently showing "no observations" while the profile still renders.
  const obsKey =
    ((profile?.user_id as string | undefined) ??
      (await resolveProfileKey(sb, userId)) ??
      (student?.user_id ?? null)) || null;
  let observations: ObservationRow[] = [];
  let observationsTableMissing = false;
  let observationsError = false;
  if (obsKey) {
    const { data, error } = await sb
      .from('user_observations')
      .select('id, content, salience, kind, created_at, consolidated_at')
      .eq('user_id', obsKey)
      .order('salience', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      // Three distinct states, never one masquerading as another:
      //   - missing table  → "未迁移" panel (expected in envs without the migration)
      //   - any other error → an explicit error state, NOT "no observations"
      //     (a perms/timeout/type failure must not read as empty data — that's the
      //     silent-wrong-result trap that hides prod misconfig).
      if (isMissingTableError(error.message)) observationsTableMissing = true;
      else observationsError = true;
    } else {
      observations = (data ?? []) as ObservationRow[];
    }
  }

  // heartbeat config (try handle, then student uuid, then students.id)
  const hbConfig = await resolveHeartbeatConfig(sb, [userId, student?.user_id, student?.id]);
  const hb: any = hbConfig?.row ?? null;

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
    observations: observations.map((o) => ({
      id: o.id,
      content: o.content,
      salience: o.salience,
      kind: o.kind,
      consolidated: !!o.consolidated_at,
      createdAt: o.created_at,
    })),
    observationsTableMissing,
    observationsError,
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

  // select('*') (not named columns) so a not-yet-migrated consent_memory column is
  // simply absent from the row rather than a PostgREST "column does not exist" error
  // (same fail-soft pattern as getMemoryConsent in src/db/students.ts).
  const { data: hbCfgs } = await sb
    .from('user_heartbeat_config')
    .select('*');

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
    // Memory opt-in: how many configured users granted consent_memory (the gate the
    // per-turn capturer + update_memory tool check before writing PII to a profile).
    // `?? 0` so a not-yet-migrated column (absent from select('*')) reads as 0, not NaN.
    memoryConsent: {
      configured: (hbCfgs ?? []).length,
      consented: (hbCfgs ?? []).filter((h) => (h as { consent_memory?: boolean }).consent_memory === true).length,
    },
  };
}

// ── AI QUALITY (flags + fabrication sentinel) ──────────────────────────────

// Pure: which "specific claim" signals does this assistant text carry? George's
// domain playbook says course numbers, prices, and RMP-style ratings must come
// from a tool, never invention — so a turn that STATES one without having called a
// tool is a fabrication suspect. Heuristic by design (the dashboard labels these
// as "needs human judgment"); exported pure so it's unit-testable without the DB.
export function fabricationSignals(content: string): string[] {
  if (!content) return [];
  const s: string[] = [];
  if (/[A-Za-z]{2,4}\s?\d{3}\b/.test(content)) s.push('course'); // WRIT 150, BUAD 280
  if (/[$¥]\s?\d|\d+\s?(刀|块|美金|usd|dollars?|\/\s?(月|mo|month))|每月\s?\d/i.test(content)) s.push('price');
  if (/\b[0-5]\.\d\b/.test(content)) s.push('rating'); // RMP 4.5 / 5.0
  return s;
}

// Pure: did this turn invoke NO tools? tool_calls.tools is the per-turn tool list
// (see getDistributions). Empty/absent/malformed → no tools → can't have verified
// a specific claim against data.
export function turnUsedNoTools(toolCalls: any): boolean {
  return !(
    toolCalls &&
    typeof toolCalls === 'object' &&
    Array.isArray(toolCalls.tools) &&
    toolCalls.tools.length > 0
  );
}

// Flagged turns (message_flags). §4A fail-soft: a not-yet-migrated table returns
// { flags: [], tableMissing: true } so the Review page shows "未迁移", never 500s.
export async function getFlaggedTurns(sb: SupabaseClient, limit = 100) {
  const { data, error } = await sb
    .from('message_flags')
    .select('id, message_id, user_id, kind, reason, model, agent, context_snapshot, actor, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    const missing = isMissingTableError(error.message);
    return { flags: [], tableMissing: missing, error: !missing };
  }
  const flags = (data ?? []).map((f: any) => ({
    id: f.id,
    messageId: f.message_id,
    handleShort: f.user_id ? maskHandle(String(f.user_id)) : '—',
    kind: f.kind,
    reason: f.reason,
    model: f.model,
    agent: f.agent,
    content: (f.context_snapshot && typeof f.context_snapshot === 'object' ? f.context_snapshot.content : null) ?? null,
    actor: f.actor,
    createdAt: f.created_at,
  }));
  return { flags, tableMissing: false, error: false };
}

// Fabrication sentinel: recent assistant turns that STATE a specific claim
// (course/price/rating) but invoked NO tool. Scans the recent window in JS (same
// .limit(N) pattern as the other reads). Heuristic surfacing for human review —
// NOT an auto-block.
export async function getFabricationSuspects(sb: SupabaseClient, opts: { scan?: number; limit?: number } = {}) {
  const scan = Math.min(opts.scan ?? 3000, 10000);
  const cap = opts.limit ?? 100;
  const { data, error } = await sb
    .from('messages')
    .select('id, user_id, content, agent, tool_calls, created_at')
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(scan);

  // A read failure must NOT read as "no suspects" (silent wrong-result). Surface it
  // so the Review page shows an error state instead of a falsely-clean panel.
  if (error) return { suspects: [], scanned: 0, error: true };

  type ScanRow = { id: string; user_id: string | null; content: string | null; agent: string | null; tool_calls: any; created_at: string };
  const suspects: Array<{
    id: string;
    handleShort: string;
    content: string;
    signals: string[];
    agent: string | null;
    createdAt: string;
  }> = [];
  let judgeable = 0; // turns we could actually judge (have tool telemetry)
  for (const m of (data ?? []) as ScanRow[]) {
    if (!m.content) continue;
    // Only judge turns whose tool telemetry is PRESENT. A null/absent tool_calls
    // means "we don't know what tools ran" (e.g. pre-enrichment historical rows),
    // NOT "no tools" — flagging those would conflate unknown with verified-no-tool.
    if (!m.tool_calls || typeof m.tool_calls !== 'object') continue;
    judgeable++;
    if (!turnUsedNoTools(m.tool_calls)) continue;
    const signals = fabricationSignals(m.content);
    if (signals.length === 0) continue;
    suspects.push({
      id: m.id,
      handleShort: m.user_id ? maskHandle(String(m.user_id)) : '—',
      content: m.content.length > 280 ? m.content.slice(0, 280) + '…' : m.content,
      signals,
      agent: m.agent,
      createdAt: m.created_at,
    });
    if (suspects.length >= cap) break;
  }
  // `scanned` reports the JUDGEABLE window (telemetry-bearing turns), not the raw
  // row count — so the UI's "scanned N" reflects what the heuristic could assess.
  return { suspects, scanned: judgeable, error: false };
}

// ── SAFETY (crisis radar + injection log) ──────────────────────────────────

// Build a uuid → display-handle map (the reverse of indexStudents): observations
// are keyed by students.user_id (uuid), but the queue shows the channel handle a
// human can act on. Falls back to the uuid when no student row maps.
function userIdToHandle(students: StudentRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of students) {
    if (s.user_id) m.set(String(s.user_id), s.imessage_id || s.wechat_open_id || String(s.user_id));
  }
  return m;
}

// Crisis radar: students who may be in real distress, for HUMAN review per the SOP.
// GATED OFF until the SOP exists (crisisRadarEnabled). Two content-matched sources,
// both run through the curated, hyperbole-aware distressSignals():
//   1. recent USER messages — the student's own words (primary; most reliable);
//   2. recent kind='emotion' observations — George's distilled emotional read.
// Merged per user (most recent hit wins, signals unioned), most-recent first.
export async function getDistressQueue(sb: SupabaseClient, opts: { scan?: number } = {}) {
  if (!crisisRadarEnabled()) return { enabled: false, queue: [] as DistressHit[] };
  const scan = Math.min(opts.scan ?? 1500, 8000);

  const [{ data: msgs }, { data: obs }, students] = await Promise.all([
    sb
      .from('messages')
      .select('user_id, content, created_at')
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(scan),
    // user_observations may not be migrated everywhere — tolerate its absence.
    sb
      .from('user_observations')
      .select('user_id, content, salience, kind, created_at')
      .eq('kind', 'emotion')
      .order('created_at', { ascending: false })
      .limit(500)
      .then((r) => r, () => ({ data: [] as any[] })),
    loadStudents(sb),
  ]);

  const handleOf = userIdToHandle(students);
  const byUser = new Map<string, DistressHit>();
  const add = (rawKey: string, handle: string, source: 'message' | 'observation', content: string, createdAt: string) => {
    const signals = distressSignals(content);
    if (signals.length === 0) return;
    const key = String(rawKey);
    const prev = byUser.get(key);
    const snippet = content.length > 240 ? content.slice(0, 240) + '…' : content;
    if (!prev) {
      byUser.set(key, { handleShort: maskHandle(handle), source, signals, snippet, createdAt });
    } else {
      for (const s of signals) if (!prev.signals.includes(s)) prev.signals.push(s);
      if (createdAt > prev.createdAt) { prev.createdAt = createdAt; prev.snippet = snippet; prev.source = source; }
    }
  };

  for (const m of (msgs ?? []) as Array<{ user_id: string | null; content: string | null; created_at: string }>) {
    if (m.user_id && m.content) add(m.user_id, String(m.user_id), 'message', m.content, m.created_at);
  }
  for (const o of (obs ?? []) as Array<{ user_id: string | null; content: string | null; created_at: string }>) {
    if (o.user_id && o.content) add(o.user_id, handleOf.get(String(o.user_id)) ?? String(o.user_id), 'observation', o.content, o.created_at);
  }

  const queue = Array.from(byUser.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { enabled: true, queue, scanned: (msgs ?? []).length };
}

// Injection attempts recorded at the HTTP boundary (admin_audit_log, action=
// injection_blocked). §4A fail-soft. Read-only view of who's probing the door.
export async function getInjectionLog(sb: SupabaseClient, limit = 50) {
  // Real admin_audit_log columns are admin_email + ts (NOT actor_email/created_at).
  const { data, error } = await sb
    .from('admin_audit_log')
    .select('admin_email, entity_id, payload, ts')
    .eq('action', 'injection_blocked')
    .order('ts', { ascending: false })
    .limit(limit);
  if (error) return { entries: [], error: !isMissingTableError(error.message), tableMissing: isMissingTableError(error.message) };
  const entries = (data ?? []).map((r: any) => ({
    handleShort: r.entity_id ? maskHandle(String(r.entity_id)) : '—',
    source: (r.payload && typeof r.payload === 'object' ? r.payload.source : null) ?? null,
    reason: (r.payload && typeof r.payload === 'object' ? r.payload.reason : null) ?? null,
    preview: (r.payload && typeof r.payload === 'object' ? r.payload.textPreview : null) ?? null,
    createdAt: r.ts,
  }));
  return { entries, error: false, tableMissing: false };
}

// ── GROWTH (onboarding funnel + retention) ─────────────────────────────────

// Pure: days between two ISO timestamps (floored, never negative). Exported for
// unit tests so the retention math isn't only exercised live.
export function daysBetween(fromISO: string, nowMs: number): number {
  const t = Date.parse(fromISO);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

// Pure: a handle is "at risk" if it was a real user (>= minMessages) but has gone
// quiet for [silentMin, silentMax] days. The upper bound keeps long-churned users
// out of the actionable list — at-risk means "reachable if we nudge now", not "gone".
export function classifyAtRisk(
  lastActiveISO: string,
  messages: number,
  nowMs: number,
  opts: { minMessages?: number; silentMin?: number; silentMax?: number } = {},
): { daysSince: number; atRisk: boolean } {
  const minMessages = opts.minMessages ?? 3;
  const silentMin = opts.silentMin ?? 7;
  const silentMax = opts.silentMax ?? 45;
  const daysSince = daysBetween(lastActiveISO, nowMs);
  return { daysSince, atRisk: messages >= minMessages && daysSince >= silentMin && daysSince <= silentMax };
}

// Onboarding funnel — DOWNGRADED to status counts + a pending-backlog list. There
// is no completed_at on pending_users (015), so a time-to-complete funnel isn't
// possible; we report counts and how long pending rows have been stuck instead.
// §4A fail-soft if pending_users isn't present.
export async function getOnboarding(sb: SupabaseClient) {
  const { data, error } = await sb
    .from('pending_users')
    .select('code, imessage_handle, status, created_at')
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) return { counts: { pending: 0, completed: 0, abandoned: 0, total: 0 }, backlog: [], tableMissing: isMissingTableError(error.message), error: !isMissingTableError(error.message) };
  const now = Date.now();
  const counts = { pending: 0, completed: 0, abandoned: 0, total: 0 };
  const backlog: Array<{ code: string; handleShort: string; ageDays: number }> = [];
  for (const r of (data ?? []) as Array<{ code: string; imessage_handle: string | null; status: string; created_at: string }>) {
    counts.total++;
    if (r.status === 'pending') counts.pending++;
    else if (r.status === 'completed') counts.completed++;
    else if (r.status === 'abandoned') counts.abandoned++;
    if (r.status === 'pending') {
      backlog.push({ code: r.code, handleShort: r.imessage_handle ? maskHandle(String(r.imessage_handle)) : '—', ageDays: daysBetween(r.created_at, now) });
    }
  }
  // Oldest-pending first — those are the most stuck / most at risk of abandoning.
  backlog.sort((a, b) => b.ageDays - a.ageDays);
  return { counts, backlog: backlog.slice(0, 50), tableMissing: false, error: false };
}

// Retention — per-handle last-active + message count from messages, classified
// into an at-risk list (was active, now quiet but still reachable). Reuses the
// same .limit(10000) JS-aggregation pattern as getUsers.
export async function getRetention(sb: SupabaseClient) {
  const { data } = await sb
    .from('messages')
    .select('user_id, created_at')
    .order('created_at', { ascending: false })
    .limit(10000);
  const now = Date.now();
  const agg = new Map<string, { messages: number; lastActive: string }>();
  for (const m of (data ?? []) as Array<{ user_id: string | null; created_at: string }>) {
    if (!m.user_id) continue;
    const k = String(m.user_id);
    const a = agg.get(k);
    if (!a) agg.set(k, { messages: 1, lastActive: m.created_at });
    else { a.messages++; if (m.created_at > a.lastActive) a.lastActive = m.created_at; }
  }
  const students = await loadStudents(sb);
  const ix = indexStudents(students);
  const atRisk: Array<{ handleShort: string; name: string | null; daysSince: number; messages: number }> = [];
  let activeUsers = 0;
  for (const [k, a] of agg) {
    const { daysSince, atRisk: risk } = classifyAtRisk(a.lastActive, a.messages, now);
    if (daysSince <= 7) activeUsers++;
    if (risk) {
      const s = ix.get(k);
      atRisk.push({ handleShort: maskHandle(k), name: s?.name ?? null, daysSince, messages: a.messages });
    }
  }
  // Most-recently-gone-quiet first (the freshest, most-recoverable lapses).
  atRisk.sort((a, b) => a.daysSince - b.daysSince);
  return { totalUsers: agg.size, activeUsers7d: activeUsers, atRisk: atRisk.slice(0, 50) };
}

// ── ADMIN ACTIONS (the only writes) ────────────────────────────────────────
export async function setHeartbeatPaused(sb: SupabaseClient, userId: string, paused: boolean) {
  // Resolve the heartbeat config key (handle, the student's uuid, or students.id)
  // via the shared candidate-ring probe — same resolver getUserDetail reads with.
  const students = await loadStudents(sb);
  const ix = indexStudents(students);
  const student = ix.get(userId);
  const hbConfig = await resolveHeartbeatConfig(sb, [userId, student?.user_id, student?.id]);
  if (!hbConfig) return { ok: false, error: 'no heartbeat config row for this user' };
  const { error } = await sb
    .from('user_heartbeat_config')
    .update({ paused, pause_until: null, updated_at: new Date().toISOString() })
    .eq('user_id', hbConfig.key);
  return { ok: !error, key: hbConfig.key, error: error?.message };
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
