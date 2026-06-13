// src/services/web-search-config.ts
// Trusted-source allowlist for WebSearch. Restricts results to quality sources
// (cuts SEO spam / misinformation, reinforces the never-invent rule). The list
// is injected into the info sub-agents' prompts as the allowed_domains they
// must pass to WebSearch (allowed_domains is model-provided per call). Retune
// in one place via WEB_SEARCH_ALLOWED_DOMAINS (comma-separated).
//
// Header last reviewed: 2026-06-13
const DEFAULT_TRUSTED_DOMAINS = [
  'usc.edu',
  'reddit.com',
  'yelp.com',
  'tripadvisor.com',
  'xiaohongshu.com',
  'dianping.com',
  'timeout.com',
  'lacity.gov',
  'metro.net',
]

export function trustedDomains(): string[] {
  const raw = process.env.WEB_SEARCH_ALLOWED_DOMAINS
  if (!raw) return DEFAULT_TRUSTED_DOMAINS
  const parsed = raw.split(',').map((d) => d.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : DEFAULT_TRUSTED_DOMAINS
}
