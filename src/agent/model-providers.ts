// src/agent/model-providers.ts
//
// Per-model provider routing for the Agent SDK. George's query() normally goes
// to the GLOBAL ANTHROPIC_BASE_URL (the gateway in .env, e.g. DeepSeek's
// /anthropic). Some models live behind a DIFFERENT Anthropic-compatible endpoint
// (Doubao / 火山方舟 Ark). For those, we override ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN PER query() call via the SDK's `env` option, so a single
// turn can run on a different provider without touching global config.
//
// Adding a provider = one entry here + its config block. The model id prefix
// decides the route, so per-user overrides and global tiers both work.

interface Provider {
  // True when `model` belongs to this provider.
  match: (model: string) => boolean
  // The per-call env override, or null when the provider isn't configured
  // (missing key) — in which case we fall back to the global gateway. Reads
  // process.env at call time so it's always current and unit-testable.
  env: () => Record<string, string> | null
}

const PROVIDERS: Provider[] = [
  {
    // Doubao via Ark's Anthropic-compatible endpoint.
    match: (m) => /^(doubao|ark-)/i.test(m),
    env: () => {
      const key = process.env.DOUBAO_API_KEY
      if (!key) return null
      return {
        ANTHROPIC_BASE_URL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding',
        // Ark authenticates with ANTHROPIC_AUTH_TOKEN; set ANTHROPIC_API_KEY too
        // so whichever the SDK reads is populated.
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_API_KEY: key,
      }
    },
  },
]

// Given the model a turn will run on, return the per-call env override that
// routes it to the right provider, or null to use the global default gateway.
export function providerEnvForModel(model: string | undefined | null): Record<string, string> | null {
  if (!model) return null
  for (const p of PROVIDERS) {
    if (p.match(model)) return p.env()
  }
  return null
}

// Convenience for buildQueryOptions: returns `{ env: {...process.env, ...override} }`
// when a provider override applies, else `{}` so the OFF path stays byte-identical
// (no extra keys spread into the SDK options).
export function providerOptionsForModel(model: string | undefined | null): { env?: Record<string, string | undefined> } {
  const override = providerEnvForModel(model)
  return override ? { env: { ...process.env, ...override } } : {}
}
