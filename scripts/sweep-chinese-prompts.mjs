// scripts/sweep-chinese-prompts.mjs
// Voice audit: extract every Chinese exemplar from prompts/*.md, back-translate ZH→EN via DeepL,
// and flag service-speak tells. Service-speak survives translation, so the English back-translation
// makes chatbot politeness visible mechanically (founder ruling 2026-07-01 — the 「不想去忽略我就行」
// class). Zero deps, node 20+ (global fetch).
//
//   DEEPL_API_KEY=... node scripts/sweep-chinese-prompts.mjs
//   (falls back to reading DEEPL_API_KEY from .env)
//
// Output: one block per string — file:line, ZH, EN, and any tells. Exit 0 always (audit, not a gate;
// the CI-facing gate for the programmatic templates is tests/eval/voice-backtranslate.test.ts).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PROMPTS = join(ROOT, 'prompts')

let KEY = process.env.DEEPL_API_KEY ?? ''
if (!KEY) {
  try {
    const env = readFileSync(join(ROOT, '.env'), 'utf8')
    KEY = env.match(/^DEEPL_API_KEY=(.+)$/m)?.[1]?.trim() ?? ''
  } catch { /* no .env */ }
}
if (!KEY) {
  console.error('DEEPL_API_KEY not set (env or .env)')
  process.exit(1)
}
const ENDPOINT = KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'

const CJK = /[一-鿿]/
const SERVICE_SPEAK = [
  /feel free/i, /don'?t hesitate/i, /just ignore (me|this|it)/i, /ignore me if/i,
  /if you (don'?t|do not) want/i, /no (worries|pressure)/i, /that'?s (fine|okay|ok)\b/i,
  /please (let me know|feel free)/i, /i'?m here (to help|for you)/i, /happy to (help|assist)/i,
  /at your convenience/i, /let me know if/i, /how can i (help|assist)/i, /is there anything else/i,
]

// Extract Chinese exemplars from one file. Sources, in order of confidence:
//   「...」 quotes (George speech examples), "..." quotes with CJK, `...` backticks with CJK,
//   few-shot `george:` lines, and majority-CJK prose lines (tagged, lower confidence).
function extract(file, text) {
  const out = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`
    for (const m of line.matchAll(/「([^」]+)」/g)) out.push({ at, kind: 'quote', zh: m[1] })
    for (const m of line.matchAll(/"([^"]+)"/g)) if (CJK.test(m[1])) out.push({ at, kind: 'quote', zh: m[1] })
    for (const m of line.matchAll(/`([^`]+)`/g)) if (CJK.test(m[1])) out.push({ at, kind: 'quote', zh: m[1] })
    const g = line.match(/^george:\s*(.+)$/)
    if (g && CJK.test(g[1])) out.push({ at, kind: 'fewshot', zh: g[1].trim() })
    if (!/[「"`]/.test(line) && !g) {
      const cjkCount = (line.match(/[一-鿿]/g) ?? []).length
      if (cjkCount >= 6 && cjkCount / line.replace(/\s/g, '').length > 0.4) {
        out.push({ at, kind: 'prose', zh: line.trim() })
      }
    }
  })
  return out
}

async function translateBatch(texts) {
  const res = await fetch(`${ENDPOINT}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts, source_lang: 'ZH', target_lang: 'EN-US' }),
  })
  if (!res.ok) throw new Error(`deepl ${res.status}: ${await res.text()}`)
  return (await res.json()).translations.map((t) => t.text)
}

const items = []
for (const f of readdirSync(PROMPTS).filter((f) => f.endsWith('.md')).sort()) {
  items.push(...extract(`prompts/${f}`, readFileSync(join(PROMPTS, f), 'utf8')))
}
// Dedup identical strings (keep first location)
const seen = new Set()
const unique = items.filter((it) => (seen.has(it.zh) ? false : (seen.add(it.zh), true)))

console.log(`sweeping ${unique.length} unique Chinese strings from prompts/ (${items.length} total occurrences)\n`)

const CHUNK = 40
let flagged = 0
for (let i = 0; i < unique.length; i += CHUNK) {
  const batch = unique.slice(i, i + CHUNK)
  const ens = await translateBatch(batch.map((b) => b.zh))
  batch.forEach((b, j) => {
    const en = ens[j]
    const hits = SERVICE_SPEAK.filter((rx) => rx.test(en))
    const tag = hits.length ? ' 🚩 ' + hits.map(String).join(' ') : ''
    if (hits.length) flagged++
    console.log(`[${b.kind}] ${b.at}${tag}`)
    console.log(`  ZH: ${b.zh}`)
    console.log(`  EN: ${en}\n`)
  })
}
console.log(`done. ${flagged} flagged of ${unique.length}.`)
