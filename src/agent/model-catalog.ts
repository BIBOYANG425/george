// src/agent/model-catalog.ts
//
// The model CATALOG: the set of models this deployment can authorize per-user,
// split by TIER —
//   main      = the agent loop (orchestrator + sub-agents)
//   emotional = the fast-path quick reply
// A model is only "available" when EVERY env var it depends on is present, so
// setting a provider key makes its models appear in the dashboard with zero UI
// change, and keys never live in the catalog.
//
//   set DOUBAO_API_KEY ──▶ availableModels('main') now includes 豆包 ──▶ dropdown shows it
//   (no key)           ──▶ filtered out                              ──▶ dropdown hides it
//
// IMPORTANT: keep this file DEPENDENCY-FREE (only process.env). It is imported by
// src/admin/user-controls.ts, which the standalone dashboard server boots with
// only SUPABASE_* set — importing config.ts (which requires ANTHROPIC_API_KEY)
// here would break that deploy. See the note atop user-controls.ts.

export type ProviderId = 'anthropic' | 'doubao' | 'deepseek' | 'kimi' | 'openai';
export type Tier = 'main' | 'emotional';

export interface CatalogModel {
  id: string; // the real model id passed to query() / the fast client
  label: string; // dashboard display name (zh-friendly)
  provider: ProviderId;
  tiers: Tier[]; // which tier(s) this model can serve
  requiresEnv: string[]; // ALL must be present for the model to count as "available"
}

// Adding a model = one row here. Adding a provider = a row + (for the MAIN tier) a
// PROVIDERS entry in model-providers.ts + (for the EMOTIONAL tier) a fast-path
// route. The catalog never holds keys — only the NAMES of the env vars to check.
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', tiers: ['main', 'emotional'], requiresEnv: ['ANTHROPIC_API_KEY'] },
  { id: 'doubao-seed-1.6', label: '豆包 Seed 1.6（主）', provider: 'doubao', tiers: ['main'], requiresEnv: ['DOUBAO_API_KEY'] },
  { id: 'doubao-seed-2-0-lite-260215', label: '豆包 Seed 2.0 Lite（情绪）', provider: 'doubao', tiers: ['emotional'], requiresEnv: ['DOUBAO_API_KEY', 'DOUBAO_MODEL'] },
  // DeepSeek is reachable only via the Anthropic-compatible gateway (ANTHROPIC_BASE_URL
  // pointed at deepseek). In prod-on-real-Claude that var is unset, so this row hides.
  { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek', tiers: ['main', 'emotional'], requiresEnv: ['ANTHROPIC_BASE_URL'] },
  // OpenAI emotional is zero-cost once a fast-path openaiChat client exists (PR-2);
  // OpenAI as a MAIN model needs an Anthropic<->OpenAI gateway (plan §6), so it is
  // intentionally omitted from the 'main' tier until then.
  // { id: 'gpt-4o-mini', label: 'GPT-4o mini（情绪）', provider: 'openai', tiers: ['emotional'], requiresEnv: ['OPENAI_API_KEY'] },
];

// The models available for a tier RIGHT NOW: in the catalog for that tier AND with
// every required env var present. Pure function of process.env, so it is always
// current and trivially unit-testable.
export function availableModels(tier: Tier): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.tiers.includes(tier) && m.requiresEnv.every((k) => !!process.env[k]));
}
