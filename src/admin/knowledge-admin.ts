// src/admin/knowledge-admin.ts
//
// "Teach george" write layer (GEORGE_TEACH_ENABLED, default-OFF): admin-added
// FACTS into the three existing knowledge tables, and behavior RULES into
// campus_knowledge under the reserved HOUSE_RULE_CATEGORY. Mirrors actions.ts —
// service-role client passed in, every mutation audited via logAdminAction,
// {ok,...} results, never throws, never leaks the key.
//
// Table shapes verified against the live BIA Services schema (bia-admin owns the
// DDL; this repo only writes existing columns):
//   campus_knowledge(id uuid pk, category text NOT NULL, title text NOT NULL,
//                    content text NOT NULL, embedding vector NULL, created_at tz)
//   freshman_faq(id uuid pk, question NOT NULL, answer NOT NULL, category NOT
//                NULL, source_thread_id NULL, confidence numeric, embedding, created_at)
//   course_tips(id uuid pk, course_code NULL, professor NULL, tip NOT NULL,
//               sentiment NULL, source_thread_id NULL, embedding, created_at)
//
// The type → table/column mapping is SERVER-OWNED (FACT_SPECS): the client picks a
// type from a fixed menu and can never name a table or column. Embedding is
// best-effort (embedText returns null without OPENAI_API_KEY; a failed embed still
// publishes the row — keyword search finds it either way).
//
// Header last reviewed: 2026-07-17

import type { SupabaseClient } from '@supabase/supabase-js'
import { embedText } from '../tools/embed-text.js'
import { HOUSE_RULE_CATEGORY, MAX_RULES, bustHouseRulesCache } from '../tools/house-rules.js'
import { logAdminAction } from './actions.js'
import { log } from '../observability/logger.js'

export type FactType = 'campus_knowledge' | 'freshman_faq' | 'course_tips'

export interface TeachInput {
  type: FactType
  fields: Record<string, string>
}

interface FieldSpec {
  required: boolean
  maxLen: number
}

interface FactSpec {
  table: FactType
  // Column → constraints. Unknown client fields are DROPPED (never inserted).
  fields: Record<string, FieldSpec>
  embedSource: (row: Record<string, string>) => string
}

const FACT_SPECS: Record<FactType, FactSpec> = {
  campus_knowledge: {
    table: 'campus_knowledge',
    fields: {
      category: { required: true, maxLen: 50 },
      title: { required: true, maxLen: 200 },
      content: { required: true, maxLen: 2000 },
    },
    embedSource: (r) => `${r.title}\n${r.content}`,
  },
  freshman_faq: {
    table: 'freshman_faq',
    fields: {
      question: { required: true, maxLen: 500 },
      answer: { required: true, maxLen: 2000 },
      category: { required: true, maxLen: 50 },
    },
    embedSource: (r) => `${r.question}\n${r.answer}`,
  },
  course_tips: {
    table: 'course_tips',
    fields: {
      tip: { required: true, maxLen: 2000 },
      course_code: { required: false, maxLen: 20 },
      professor: { required: false, maxLen: 100 },
      sentiment: { required: false, maxLen: 20 },
    },
    embedSource: (r) => r.tip,
  },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isFactType(v: unknown): v is FactType {
  return v === 'campus_knowledge' || v === 'freshman_faq' || v === 'course_tips'
}

// Validate + normalize a fact WITHOUT writing (powers the Preview step). Trims
// every field, drops unknown fields, enforces required/caps, and rejects the
// reserved rules category so the fact form can never create a rule row.
export function normalizeFact(
  input: TeachInput,
): { ok: true; table: FactType; row: Record<string, string> } | { ok: false; error: string } {
  if (!isFactType(input.type)) return { ok: false, error: `unknown fact type: ${String(input.type)}` }
  const spec = FACT_SPECS[input.type]
  const row: Record<string, string> = {}
  for (const [col, fs] of Object.entries(spec.fields)) {
    const raw = typeof input.fields?.[col] === 'string' ? input.fields[col].trim() : ''
    if (!raw) {
      if (fs.required) return { ok: false, error: `missing required field: ${col}` }
      continue
    }
    if (raw.length > fs.maxLen) return { ok: false, error: `${col} too long (max ${fs.maxLen} chars)` }
    row[col] = raw
  }
  if (row.category === HOUSE_RULE_CATEGORY) return { ok: false, error: 'reserved category' }
  return { ok: true, table: spec.table, row }
}

// Embed + insert one fact. Returns the STORED row (with id/created_at) so the UI
// can show exactly what went live. Audited.
export async function publishFact(
  sb: SupabaseClient,
  input: TeachInput,
  actor: string,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; error: string }> {
  const norm = normalizeFact(input)
  if (!norm.ok) return norm
  try {
    // Best-effort embed: null without OPENAI_API_KEY; a thrown embed error is
    // logged and the row publishes unembedded (keyword search still finds it).
    let embedding: number[] | null = null
    try {
      embedding = await embedText(FACT_SPECS[norm.table].embedSource(norm.row))
    } catch (err) {
      log('warn', 'teach_embed_failed', { table: norm.table, error: (err as Error).message })
    }
    const { data, error } = await sb
      .from(norm.table)
      .insert({ ...norm.row, embedding })
      .select()
      .single()
    if (error) return { ok: false, error: error.message }
    await logAdminAction(sb, {
      actor,
      action: 'teach_add_fact',
      entityType: 'knowledge',
      entityId: String((data as { id?: unknown })?.id ?? ''),
      payload: { table: norm.table, row: norm.row, embedded: embedding !== null },
    })
    return { ok: true, row: data as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// Newest-first rows for the CMS list. Lists ALL rows in the table (admin-taught
// AND ingested corpus — there is no source column to tell them apart, and being
// able to delete a bad ingested fact is a feature). campus_knowledge excludes the
// reserved rules category. Returns [] on any failure.
export async function listFacts(
  sb: SupabaseClient,
  type: FactType,
  limit = 100,
): Promise<Array<Record<string, unknown>>> {
  if (!isFactType(type)) return []
  try {
    const cols = ['id', 'created_at', ...Object.keys(FACT_SPECS[type].fields)].join(', ')
    let q = sb.from(type).select(cols).order('created_at', { ascending: false }).limit(Math.min(limit, 200))
    if (type === 'campus_knowledge') q = q.neq('category', HOUSE_RULE_CATEGORY)
    const { data, error } = await q
    if (error) {
      log('warn', 'teach_list_failed', { table: type, error: error.message })
      return []
    }
    return (data ?? []) as unknown as Array<Record<string, unknown>>
  } catch (err) {
    log('warn', 'teach_list_failed', { table: type, error: (err as Error).message })
    return []
  }
}

// Delete one fact by uuid, scoped to the table. campus_knowledge deletes carry
// .neq(reserved) so a fact-delete can never remove a rule. Audited; a missing id
// is ok:true removed:0 (idempotent).
export async function deleteFact(
  sb: SupabaseClient,
  type: FactType,
  id: string,
  actor: string,
): Promise<{ ok: boolean; removed?: number; error?: string }> {
  if (!isFactType(type)) return { ok: false, error: `unknown fact type: ${String(type)}` }
  if (!UUID_RE.test(id)) return { ok: false, error: 'invalid id' }
  try {
    let q = sb.from(type).delete().eq('id', id)
    if (type === 'campus_knowledge') q = q.neq('category', HOUSE_RULE_CATEGORY)
    const { data, error } = await q.select('id')
    if (error) return { ok: false, error: error.message }
    const removed = (data ?? []).length
    await logAdminAction(sb, {
      actor,
      action: 'teach_delete_fact',
      entityType: 'knowledge',
      entityId: id,
      payload: { table: type, removed },
    })
    return { ok: true, removed }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Rules (campus_knowledge rows under the reserved category) ────────────────

const RULE_LABEL_MAX = 100
const RULE_TEXT_MAX = 500

export function normalizeRule(input: {
  label?: string
  rule?: string
}): { ok: true; row: { category: string; title: string; content: string } } | { ok: false; error: string } {
  const label = (input.label ?? '').trim()
  const rule = (input.rule ?? '').trim()
  if (!rule) return { ok: false, error: 'missing required field: rule' }
  if (rule.length > RULE_TEXT_MAX) return { ok: false, error: `rule too long (max ${RULE_TEXT_MAX} chars)` }
  if (label.length > RULE_LABEL_MAX) return { ok: false, error: `label too long (max ${RULE_LABEL_MAX} chars)` }
  return { ok: true, row: { category: HOUSE_RULE_CATEGORY, title: label || 'house rule', content: rule } }
}

// Insert one behavior rule. No embedding (rules are read by category, never
// searched). Busts the in-process rules cache so a same-process read sees it
// immediately; other processes converge within the 60s TTL. Audited.
export async function publishRule(
  sb: SupabaseClient,
  input: { label?: string; rule?: string },
  actor: string,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; error: string }> {
  const norm = normalizeRule(input)
  if (!norm.ok) return norm
  try {
    const { count, error: countErr } = await sb
      .from('campus_knowledge')
      .select('id', { count: 'exact', head: true })
      .eq('category', HOUSE_RULE_CATEGORY)
    if (!countErr && typeof count === 'number' && count >= MAX_RULES) {
      return { ok: false, error: `rule cap reached (${MAX_RULES}) — delete one first` }
    }
    const { data, error } = await sb.from('campus_knowledge').insert({ ...norm.row, embedding: null }).select().single()
    if (error) return { ok: false, error: error.message }
    bustHouseRulesCache()
    await logAdminAction(sb, {
      actor,
      action: 'teach_add_rule',
      entityType: 'knowledge',
      entityId: String((data as { id?: unknown })?.id ?? ''),
      payload: { title: norm.row.title, content: norm.row.content },
    })
    return { ok: true, row: data as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// Oldest-first (matches injection order, so the list reads as the prompt does).
export async function listRules(sb: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  try {
    const { data, error } = await sb
      .from('campus_knowledge')
      .select('id, created_at, title, content')
      .eq('category', HOUSE_RULE_CATEGORY)
      .order('created_at', { ascending: true })
      .limit(MAX_RULES)
    if (error) {
      log('warn', 'teach_list_failed', { table: 'rules', error: error.message })
      return []
    }
    return (data ?? []) as unknown as Array<Record<string, unknown>>
  } catch (err) {
    log('warn', 'teach_list_failed', { table: 'rules', error: (err as Error).message })
    return []
  }
}

// Delete one rule by uuid — scoped to the reserved category, so a rule-delete can
// never remove a fact. Busts the cache. Audited.
export async function deleteRule(
  sb: SupabaseClient,
  id: string,
  actor: string,
): Promise<{ ok: boolean; removed?: number; error?: string }> {
  if (!UUID_RE.test(id)) return { ok: false, error: 'invalid id' }
  try {
    const { data, error } = await sb
      .from('campus_knowledge')
      .delete()
      .eq('id', id)
      .eq('category', HOUSE_RULE_CATEGORY)
      .select('id')
    if (error) return { ok: false, error: error.message }
    bustHouseRulesCache()
    const removed = (data ?? []).length
    await logAdminAction(sb, {
      actor,
      action: 'teach_delete_rule',
      entityType: 'knowledge',
      entityId: id,
      payload: { removed },
    })
    return { ok: true, removed }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
