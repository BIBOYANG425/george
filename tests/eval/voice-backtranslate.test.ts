// tests/eval/voice-backtranslate.test.ts
// Back-translation voice lint: service-speak survives translation, so translating George's outgoing
// Chinese copy BACK to English makes chatbot politeness visible mechanically. Example: the retired
// tail 「不想去忽略我就行」 back-translates to "just ignore me if you don't want to" — customer-service
// English wearing 哈哈 (founder ruling 2026-07-01, see prompts/whats-happening.md "know when to bridge").
//
// Gated on DEEPL_API_KEY (unset in CI → suite skips, zero API calls, zero module side effects —
// imports are dynamic inside the tests). Free-tier keys (":fx") route to api-free.deepl.com.
// This lints the PROGRAMMATIC templates (the strings sent verbatim). LLM-generated replies are the
// conversation eval harness's job, not this file's.

import { describe, expect, it } from 'vitest'

const KEY = process.env.DEEPL_API_KEY ?? ''
const ENDPOINT = KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
const d = KEY ? describe : describe.skip

// English tells of service-speak. If a back-translation matches any of these, the Chinese source
// carries chatbot politeness a real 学长 would never text.
const SERVICE_SPEAK: RegExp[] = [
  /feel free/i,
  /don'?t hesitate/i,
  /just ignore (me|this|it)/i,
  /ignore me if/i,
  /if you (don'?t|do not) want/i,
  /no (worries|pressure)/i,
  /that'?s (fine|okay|ok)\b/i,
  /please (let me know|feel free)/i,
  /i'?m here (to help|for you)/i,
  /happy to (help|assist)/i,
  /at your convenience/i,
  /let me know if/i,
]

async function backTranslate(zh: string): Promise<string> {
  const res = await fetch(`${ENDPOINT}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: [zh], source_lang: 'ZH', target_lang: 'EN-US' }),
  })
  if (!res.ok) throw new Error(`deepl ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { translations: { text: string }[] }
  return data.translations[0].text
}

const tells = (en: string): string[] => SERVICE_SPEAK.filter((rx) => rx.test(en)).map(String)

const SAMPLE_POST = { category: '自习', content: null, location: 'K-town', max_people: 3, current_people: 2 }
const SAMPLE_CAND = {
  student_id: 's1', rrf_score: 0.05, semantic_sim: 0.7, tag_overlap: 1,
  matched_tags: ['hiking'], best_facet: 'hiking',
}

d('voice back-translation lint (DeepL)', () => {
  it('positive control: the retired opt-out tail IS detected as service-speak', async () => {
    const en = await backTranslate('你之前提到hiking 想去我帮你报名 不想去忽略我就行哈哈哈')
    expect(tells(en), `back-translation was: "${en}"`).not.toHaveLength(0)
  }, 20000)

  it('composePingBubbles (live auto path) is clean', async () => {
    const { composePingBubbles } = await import('../../src/services/squad-ping-deps.js')
    for (const bubble of composePingBubbles(SAMPLE_POST, SAMPLE_CAND)) {
      const en = await backTranslate(bubble)
      expect(tells(en), `"${bubble}" back-translates to "${en}"`).toHaveLength(0)
    }
  }, 30000)

  it('composeIntroFor (concierge intro) is clean', async () => {
    const { composeIntroFor } = await import('../../src/services/match-proposal-deps.js')
    for (const bubble of composeIntroFor(SAMPLE_POST, 'hiking')) {
      const en = await backTranslate(bubble)
      expect(tells(en), `"${bubble}" back-translates to "${en}"`).toHaveLength(0)
    }
  }, 30000)

  it('the prompt bridge example is clean', async () => {
    // Mirrors prompts/whats-happening.md "know when to bridge" — keep in sync by hand.
    const en = await backTranslate('诶 要不我帮你看看有没有人一起?')
    expect(tells(en), `back-translation was: "${en}"`).toHaveLength(0)
  }, 20000)
})
