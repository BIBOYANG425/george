// src/admin/user-controls.ts
//
// Admin per-user runtime controls: which MODEL a user runs on + a daily message
// LIMIT + a hard BLOCK. Set from the dashboard, enforced in the orchestrator.
//
// Storage: an atomic JSON file at data/user-controls.json. george's current
// deployment is single-host (Mac), so the full server (orchestrator) and the
// dashboard share one filesystem — a file store needs no DDL and works for any
// handle (students AND web visitors who have no students row). The shape mirrors
// what a future `user_controls` Postgres table would hold, so swapping the two
// read/write functions over to Supabase later is a contained change.
//
// Keyed by the channel handle (messages.user_id === orchestrator args.userId).

import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../db/client.js';

const STORE_PATH = path.resolve(process.cwd(), 'data', 'user-controls.json');

export interface UserControls {
  modelOverride: string | null; // null/empty = inherit global default
  dailyMessageLimit: number | null; // null = unlimited
  blocked: boolean;
  // Optional custom message shown to the user when they are blocked or hit the
  // daily limit. Empty = use the in-voice default. This is what the user SEES —
  // a block/limit must never be silent.
  feedbackMessage: string | null;
  note: string | null; // internal admin note (not shown to the user)
  updatedAt: string | null;
  updatedBy: string | null;
}

const DEFAULTS: UserControls = {
  modelOverride: null,
  dailyMessageLimit: null,
  blocked: false,
  feedbackMessage: null,
  note: null,
  updatedAt: null,
  updatedBy: null,
};

type Store = Record<string, UserControls>;

// Short in-process cache so the orchestrator hot path doesn't re-read the file
// every turn. Writes bust it in-process; cross-process (dashboard → server)
// changes take effect within TTL.
let _cache: { store: Store; at: number } | null = null;
const TTL_MS = 3000;

function readStore(): Store {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.store;
  let store: Store = {};
  try {
    if (fs.existsSync(STORE_PATH)) {
      store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) as Store;
    }
  } catch (err) {
    console.error('[user-controls] read failed:', (err as Error).message);
    store = {};
  }
  _cache = { store, at: Date.now() };
  return store;
}

function writeStore(store: Store): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE_PATH); // atomic swap
    _cache = { store, at: Date.now() };
  } catch (err) {
    console.error('[user-controls] write failed:', (err as Error).message);
    throw err;
  }
}

export function getUserControls(userId: string): UserControls {
  const row = readStore()[userId];
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
}

export function listUserControls(): Store {
  return readStore();
}

export function setUserControls(
  userId: string,
  patch: Partial<Pick<UserControls, 'modelOverride' | 'dailyMessageLimit' | 'blocked' | 'feedbackMessage' | 'note'>>,
  updatedBy = 'admin',
): UserControls {
  const store = { ...readStore() };
  const prev = store[userId] ? { ...DEFAULTS, ...store[userId] } : { ...DEFAULTS };
  const next: UserControls = {
    ...prev,
    ...('modelOverride' in patch ? { modelOverride: normStr(patch.modelOverride) } : {}),
    ...('dailyMessageLimit' in patch ? { dailyMessageLimit: normLimit(patch.dailyMessageLimit) } : {}),
    ...('blocked' in patch ? { blocked: !!patch.blocked } : {}),
    ...('feedbackMessage' in patch ? { feedbackMessage: normStr(patch.feedbackMessage) } : {}),
    ...('note' in patch ? { note: normStr(patch.note) } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  store[userId] = next;
  writeStore(store);
  return next;
}

// UTC instant of the most recent LA (America/Los_Angeles) midnight. George's
// users + active-hours model are LA-local, so "today" resets at LA midnight, not
// UTC midnight (which is 4-5pm local). Robust across PST/PDT: the difference
// between "now in LA wall-clock" and "LA wall-clock floored to midnight" is the
// elapsed-since-LA-midnight, which we subtract from the real now.
export function startOfLADayISO(): string {
  const now = new Date();
  const laNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const laMidnight = new Date(laNow);
  laMidnight.setHours(0, 0, 0, 0);
  const elapsed = laNow.getTime() - laMidnight.getTime();
  return new Date(now.getTime() - elapsed).toISOString();
}

// Count today's USER-role messages for a handle (the daily-limit denominator).
// Resets at LA midnight; the live entry paths save the user turn before the
// orchestrator runs, so this includes the in-flight message.
export async function countTodayUserMessages(userId: string): Promise<number> {
  const today = startOfLADayISO();
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('role', 'user')
    .gte('created_at', today);
  return count ?? 0;
}

// A model id has to at least look like a known provider's id, else passing it to
// query() throws and 500s EVERY turn for that user. We can't enumerate every
// valid id (new ones ship constantly), so we gate on a known-provider prefix —
// permissive enough for real ids, strict enough to reject typos like "fast" or
// "gpt5-turbo-mega". An unrecognized override is ignored (fall back to default)
// rather than bricking the user.
const MODEL_ID_RE = /^(claude-|deepseek|moonshot|kimi|gpt-|o[0-9]|gemini-|us\.anthropic\.|anthropic\.)/i;

// Resolve the model a user should run on (override or the supplied fallback).
export function resolveModelForUser(userId: string, fallback: string): string {
  const c = getUserControls(userId);
  const override = c.modelOverride?.trim();
  if (override && MODEL_ID_RE.test(override)) return override;
  return fallback;
}

// In-voice defaults shown to a user who is blocked or over their daily limit.
// A block/limit must NEVER be silent — the user always gets one of these (or the
// admin's custom feedbackMessage).
function defaultFeedback(reason: 'blocked' | 'limit', limit?: number | null): string {
  if (reason === 'limit') {
    return `今天的消息额度用完啦${limit != null ? `（每天 ${limit} 条）` : ''} 😮‍💨 学长也得歇会儿，明天再来找我哈~`;
  }
  return '学长这边暂时没法回你消息了🥲 如果你觉得是误会，可以联系 BIA 小助手帮你看看。';
}

// The full gate the orchestrator calls at the top of a turn. Always carries a
// `message` when not allowed, so the caller can reply instead of going silent.
export async function checkUsageAllowed(userId: string): Promise<{
  allowed: boolean;
  reason?: 'blocked' | 'limit';
  used?: number;
  limit?: number;
  message?: string;
}> {
  const c = getUserControls(userId);
  if (c.blocked) {
    return { allowed: false, reason: 'blocked', message: c.feedbackMessage || defaultFeedback('blocked') };
  }
  if (c.dailyMessageLimit != null) {
    const used = await countTodayUserMessages(userId);
    if (used > c.dailyMessageLimit) {
      return {
        allowed: false,
        reason: 'limit',
        used,
        limit: c.dailyMessageLimit,
        message: c.feedbackMessage || defaultFeedback('limit', c.dailyMessageLimit),
      };
    }
    return { allowed: true, used, limit: c.dailyMessageLimit };
  }
  return { allowed: true };
}

// Today's usage snapshot for the dashboard (used + configured limit).
export async function getUsageSnapshot(userId: string): Promise<{ used: number; limit: number | null }> {
  const c = getUserControls(userId);
  const used = await countTodayUserMessages(userId);
  return { used, limit: c.dailyMessageLimit };
}

function normStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function normLimit(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// The model choices the dashboard offers — DERIVED from the actual runtime
// config (GEORGE_MODEL_FAST/SMART + the CLI default), not a hardcoded guess, so
// the dropdown always reflects models this deployment can really run. Admin can
// still type a custom id (validated by resolveModelForUser's prefix check).
//
// Note on this project's convention: model ids are written as Claude ids
// (claude-haiku/sonnet/opus). Locally the DeepSeek `/anthropic` gateway
// auto-maps them to deepseek tiers (haiku/sonnet→deepseek-v4-flash,
// opus→deepseek-v4-pro); in prod they hit real Claude. So the SAME id is
// portable across both — that's intentional, not a misconfig.
export function getModelChoices(): Array<{ id: string; label: string }> {
  const fast = process.env.GEORGE_MODEL_FAST || 'claude-haiku-4-5-20251001';
  const smart = process.env.GEORGE_MODEL_SMART || 'claude-sonnet-4-6';
  const cli = process.env.ANTHROPIC_MODEL;
  const viaDeepSeek = (process.env.ANTHROPIC_BASE_URL || '').includes('deepseek');
  const map = viaDeepSeek ? '（本地经 DeepSeek 网关映射）' : '';
  const out: Array<{ id: string; label: string }> = [{ id: '', label: `默认 · 继承全局（FAST=${fast}）` }];
  const seen = new Set<string>(['']);
  const add = (id: string | undefined, label: string) => {
    if (id && !seen.has(id)) { seen.add(id); out.push({ id, label }); }
  };
  add(fast, `FAST 档：${fast}${map}`);
  add(smart, `SMART 档：${smart}${map}`);
  add(cli, `CLI 默认：${cli}`);
  return out;
}
