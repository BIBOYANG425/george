// src/tools/house-rules.ts
//
// Admin-taught HOUSE RULES ("Teach george", GEORGE_TEACH_ENABLED, default-OFF).
// Behavior rules the admin adds live from the dashboard, stored as rows in the
// EXISTING campus_knowledge table under the reserved category below (bia-admin
// owns the schema; reusing a table keeps this migration-free). Read at
// prompt-build time and injected FIRST in the shared overlay stack
// (buildOverlayStack), so a rule takes effect on the next message with no deploy.
//
// The reserved category is excluded from the campus_knowledge fact-search path
// (see campus-knowledge.ts) and from the fact CMS list/delete (knowledge-admin.ts),
// so rules never surface as "facts" — this module is their only reader.
//
// TRUST MODEL (deliberate — do not "harden" this into inertness): unlike the
// user profile / recall blocks, house rules are AUTHORED BY ADMINS behind the
// dashboard token + Cloudflare Access. They are trusted standing instructions,
// so they are NOT fenced as untrusted data; they are allowed to direct behavior.
//
// Leaf module: imports only db/client, flags, logger — no admin/express, no
// agent SDK — so the orchestrator AND the dashboard can both import it freely.
//
// Header last reviewed: 2026-07-17

import { supabase } from '../db/client.js'
import { getFlags } from '../flags.js'
import { log } from '../observability/logger.js'

export const HOUSE_RULE_CATEGORY = '__house_rule__'

// Bounds on the injected block so an admin can't accidentally blow the prompt:
// at most MAX_RULES rows, rendered lines capped at BLOCK_CHAR_CAP chars (whole
// lines only — mirrors recall.ts renderBlock).
export const MAX_RULES = 20
const BLOCK_CHAR_CAP = 1200

const HEADER = '# HOUSE RULES (standing policy set by BIA admins — follow these)'

// "Live within a minute": one DB read per TTL per process. An admin add/delete
// busts the local cache immediately (bustHouseRulesCache from the write path);
// other processes converge within the TTL.
const TTL_MS = 60_000
let cache: { at: number; block: string } | null = null

export function bustHouseRulesCache(): void {
  cache = null
}

// Render header + "- <rule>" lines in insertion order (oldest first — stable,
// earlier rules keep their position as new ones are added). Whole lines only;
// always keep header + 1 line if any rule exists.
export function renderHouseRules(rules: string[]): string {
  const cleaned = rules.map((r) => (r ?? '').trim()).filter(Boolean)
  if (cleaned.length === 0) return ''
  let block = HEADER
  let count = 0
  for (const rule of cleaned.slice(0, MAX_RULES)) {
    const candidate = `${block}\n- ${rule}`
    if (count > 0 && candidate.length > BLOCK_CHAR_CAP) break
    block = candidate
    count += 1
  }
  return block
}

// The injectable block, or '' (flag off / no rules / any failure). NEVER throws —
// a rules read can never block a reply. OFF path returns before any DB work, so
// the prompt is byte-identical to pre-feature behavior.
export async function loadHouseRules(): Promise<string> {
  if (!getFlags().teachEnabled) return ''
  if (cache && Date.now() - cache.at < TTL_MS) return cache.block
  try {
    const { data, error } = await supabase
      .from('campus_knowledge')
      .select('content')
      .eq('category', HOUSE_RULE_CATEGORY)
      .order('created_at', { ascending: true })
      .limit(MAX_RULES)
    if (error) {
      log('warn', 'house_rules_load_failed', { error: error.message })
      return ''
    }
    const block = renderHouseRules(((data ?? []) as Array<{ content: string }>).map((r) => r.content))
    cache = { at: Date.now(), block }
    return block
  } catch (err) {
    log('warn', 'house_rules_load_failed', { error: (err as Error).message })
    return ''
  }
}
