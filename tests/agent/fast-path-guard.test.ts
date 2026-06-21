import { describe, it, expect } from 'vitest'
import { scanFabricationRisk, detectUnsourcedClaim } from '../../src/agent/fast-path-guard.js'

// Helpers: a "bail" means the scanner found at least one asserted-fact hit.
const bails = (t: string) => scanFabricationRisk(t).length > 0
const ids = (t: string) => scanFabricationRisk(t).map((h) => h.id)

describe('scanFabricationRisk — every risk pattern fires on its canonical fabrication', () => {
  it('event_assert: a specific gathering stated as fact', () => {
    expect(ids('bia 这周刚好有个四人的火锅局')).toContain('event_assert')
  })
  it('event_count: "有个…局" with detail', () => {
    expect(ids('今晚有个轰趴')).toContain('event_count')
  })
  it('open_now: asserting current opening status', () => {
    expect(ids('in-n-out 现在还开着')).toContain('open_now')
  })
  it('open_now: english "still open / open now / 24h"', () => {
    expect(bails('the dining hall is still open right now')).toBe(true)
    expect(bails('那家是 24小时 的')).toBe(true)
  })
  it('venue_assert: unverified shops exist', () => {
    expect(ids('学校附近有好几家粤菜馆')).toContain('venue_assert')
  })
  it('course_code: uppercase+space AND lowercase-adjacent shapes', () => {
    expect(ids('选 WRIT 150 准没错')).toContain('course_code')
    expect(ids('writ150 这门选 Theis')).toContain('course_code')
    expect(ids('CS-101 还行')).toContain('course_code')
  })
  it('price_claim: a dollar / 块 / 月租 figure', () => {
    expect(bails('那间一个月 $1200')).toBe(true)
    expect(bails('差不多 800 块一个月')).toBe(true)
  })
  it('prof_rating: professor + a rating', () => {
    expect(ids('那个教授 rmp 4.8')).toContain('prof_rating')
  })
})

describe('scanFabricationRisk — the plan ❌ examples must all bail', () => {
  const mustBail = [
    '附近有几家粤菜馆能吃出家里味道',
    'bia 这周有个四人火锅局',
    '楼下 in-n-out 现在还开着',
    'writ150 选 Smith，评分 4.8',
    'usc 附近有几家粤菜馆烧腊很正',
  ]
  for (const t of mustBail) {
    it(`bails: ${t}`, () => expect(bails(t)).toBe(true))
  }
})

describe('scanFabricationRisk — §4 adversarial George-reply assertions must bail 100%', () => {
  const adversarial = [
    '今晚 bia 有个桌游局，来不来',
    'in-n-out 现在还开着，去吧',
    'writ150 这门选 Theis 准没错',
    '学校附近有家粤菜馆，味道正',
    '那门课的教授评分 4.9，闭眼冲',
  ]
  for (const t of adversarial) {
    it(`bails: ${t}`, () => expect(bails(t)).toBe(true))
  }
})

describe('scanFabricationRisk — offer ≠ assert (the plan ✅ examples must NOT bail)', () => {
  const mustPass = [
    '想吃粤菜的话我帮你扒一下附近靠谱的，要不要',
    '三点多能 walk-in 的真不多了🥲 我帮你查查这会儿还开着的',
    '想找个局的话我帮你看看最近有啥，要不要',
    '想知道哪门课好我帮你查查，别急',
  ]
  for (const t of mustPass) {
    it(`passes: ${t}`, () => {
      expect(scanFabricationRisk(t)).toEqual([])
    })
  }

  it('offer-suppression is clause-scoped: an offer later does NOT excuse an assertion earlier', () => {
    // assertion in clause 1, offer in clause 2 → still bails on clause 1.
    expect(bails('in-n-out 现在还开着，要不我帮你查查别的')).toBe(true)
  })

  it('the SAME content without an offer verb bails', () => {
    expect(bails('in-n-out 这会儿还开着')).toBe(true)
    expect(bails('附近有家粤菜馆')).toBe(true)
  })

  it('course / price / prof are NOT offer-suppressible (a number is a fact even inside an offer)', () => {
    expect(bails('我帮你查查 writ150 怎么样')).toBe(true)
    expect(bails('我帮你看看是不是 $1200 一个月')).toBe(true)
  })
})

describe('scanFabricationRisk — benign warmth must never bail', () => {
  const safe = [
    '哈哈哈哈 这也太惨了吧😢 摆烂一天不寒碜',
    '想家就视频打给爸妈呗，他们指定也想你🥹',
    '别 emo 了，三点半正是吃宵夜的好时候😋',
    '去 Leavey 三楼吧，那儿最安静',
    'K-town 性价比是真高，住那儿值',
    '今天有点累就早点睡，明天又是新的一天',
    '周末愉快，好好休息哈',
  ]
  for (const t of safe) {
    it(`passes: ${t}`, () => {
      expect(scanFabricationRisk(t)).toEqual([])
    })
  }
})

describe('scanFabricationRisk — allow-list masks the NAME, never the structural fabrication', () => {
  it('a known place + a fabricated "有好几家…店" still bails (mask removes only the proper noun)', () => {
    // "USC Village" is masked, but "有好几家奶茶店" is still an unverified assertion.
    expect(bails('USC Village 有好几家奶茶店')).toBe(true)
  })
})

describe('scanFabricationRisk — regressions from the adversarial audit (wf_a4d53363)', () => {
  it('venue_named: presupposition venue "那家川菜馆" (no 有…家 structure) bails', () => {
    expect(bails('USC Village 那家川菜馆超正宗 麻婆豆腐绝了')).toBe(true)
    expect(bails('斜对面那个潮汕砂锅粥贼好喝')).toBe(true)
  })
  it('open_now synonyms: "开到很晚" / "24/7" / "通宵的" / "还在迎客" bail', () => {
    expect(bails('k-town 那边好多店开到很晚，半夜也能吃上')).toBe(true)
    expect(bails('那家 cafe 24/7 open 的')).toBe(true)
    expect(bails('in n out 这个点通宵的')).toBe(true)
  })
  it('event_assert broadened time-words + windows: "明天…industry 深聊局"', () => {
    expect(bails('明天 BIA 有个 industry 深聊局')).toBe(true)
    expect(bails('明晚有个 city walk 局 在 DTLA 集合')).toBe(true)
  })
  it('prof_rating with the number BEFORE the keyword bails', () => {
    expect(bails('最稳的就是 4.0 以上那几个 prof')).toBe(true)
  })
  it('venue_assert covers 烧腊 / 火锅 nouns', () => {
    expect(bails('附近有家烧腊挺正的')).toBe(true)
  })

  // The FALSE-POSITIVE the audit caught: a generic OFFER to look up ratings must
  // NOT bail. prof_rating now requires an actual number, so bare "评分高" passes.
  it('offer to look up a prof rating (no number asserted) does NOT bail', () => {
    expect(scanFabricationRisk('你想选哪门我帮你查查那门哪个教授评分高，要不要把课号发我')).toEqual([])
    expect(scanFabricationRisk('想选 writing 课？我帮你扒一下哪个 prof 评分高再告诉你')).toEqual([])
  })
})

// Documented regex ceiling (not chased on purpose — see fast-path-guard.ts notes):
// deliberate evasions that real models rarely produce and whose regexes would add
// false-positive surface on casual numerals. The prompt rules + full-agent
// grounding are the defense for these:
//   - spaced course codes: "W R I T 150"
//   - Chinese-numeral codes/prices/ratings: "writ 一五零", "一千二", "四点九"

describe('detectUnsourcedClaim — full-agent backstop', () => {
  it('flags + strips a fake "(source: …)" citation, leaving the prose', () => {
    const r = detectUnsourcedClaim('MUSC 102 和 ART 141 都不错 (source: usc catalogue)')
    expect(r.hit).toBe(true)
    expect(r.ids).toContain('fake_citation')
    expect(r.ids).toContain('course_code')
    expect(r.cleaned).not.toMatch(/source/i)
    expect(r.cleaned).toContain('MUSC 102')
  })

  it('handles full-width "（来源：…）" citations too', () => {
    const r = detectUnsourcedClaim('那个教授很好（来源：ratemyprofessor）')
    expect(r.hit).toBe(true)
    expect(r.cleaned).not.toMatch(/来源/)
  })

  it('leaves a clean emotional reply untouched', () => {
    const r = detectUnsourcedClaim('嗯嗯 我懂你的感受🥹 先睡一觉')
    expect(r.hit).toBe(false)
    expect(r.cleaned).toBe('嗯嗯 我懂你的感受🥹 先睡一觉')
  })
})
