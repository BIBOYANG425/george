// src/agent/fast-path-guard.ts
//
// Post-output anti-fabrication scan for the fast path. The fast responder (the
// no-lookup small-talk tier; Doubao when configured) is told in its prompt to
// "never invent a fact," but models — Doubao especially — ignore that and reach
// for a concrete shop / gathering / opening-hour / course / price to sound warm.
// The persona eval (wf_85345473) caught 6/12 emotional replies fabricating
// venues, gatherings, and "still-open" claims. A prompt can't be trusted to
// self-police, so this scans the DRAFT after generation and tells `fastReply` to
// BAIL (return null → run the grounded full agent) the moment it asserts a
// specific fact.
//
// Design (docs/superpowers/plans/2026-06-20-doubao-fastpath-antifabrication.md):
//  - RECALL-BIASED. A false bail costs a few seconds (the full agent answers,
//    grounded); a miss ships a fabricated fact to the most vulnerable users.
//    When in doubt we over-bail.
//  - OFFER ≠ ASSERT. "我帮你查查这会儿还开着的" (offering to look it up) is allowed;
//    "in-n-out 现在还开着" (asserting it as fact) is not. An offer verb in the same
//    clause as a place/time/event hit suppresses that hit so the warm offer
//    survives. Course codes / prices / prof ratings are facts regardless of
//    framing, so they are never offer-suppressible.
//  - ALLOW-LIST. George legitimately knows USC place names (Leavey, K-town, USC
//    Village…). They are masked before scanning so a known landmark next to a
//    verb can't seed a false venue hit. Masking only removes the proper noun, not
//    the structural fabrication tokens (有/家/现在/开着/digits), so it can never
//    hide a real fabrication.

import { ALIASES } from '../services/usc-aliases.js';

export interface FabricationHit {
  id: string;
  reason: string;
  match: string;
}

// Categories that read as an OFFER when George says "I'll look it up" but a
// FABRICATION when stated as fact. Course/price/prof are excluded: a course
// number or a dollar figure is an unverified fact even inside an offer.
const OFFERABLE = new Set(['event_assert', 'event_count', 'open_now', 'venue_assert', 'venue_named']);

// "I'll go check / look it up / ask around" — George offering to ground the
// answer instead of asserting it. Matched per-clause so an assertion in one
// breath and an offer in the next don't cancel each other out.
const OFFER_RX =
  /(我?帮你?(查|看|问|搜|找|瞅|瞧|扒|搂|瞄)|查查|看看|问问|搜搜|我去(查|问|看|搜)|要不要我|帮忙(查|看|问|搜)|(查|搜|看|问)一下)/;

const RISK_PATTERNS: Array<{ id: string; rx: RegExp; reason: string }> = [
  // 1. Asserting a specific gathering/event exists (the gravest — eval flagged
  //    "bia这周刚好有个四人的火锅局"). Time-anchored, so the windows are wide. Bare
  //    "饭" is excluded so casual "吃个饭" chat doesn't bail; a real gathering needs
  //    局/聚/趴/火锅/party/海底捞/一桌. Time list + windows widened after the
  //    adversarial audit (caught "明天…industry 深聊局", "礼拜六…凑了一桌打边炉").
  {
    id: 'event_assert',
    rx: /(这周|本周|这礼拜|这两天|这几天|今晚|今天|明晚|明天|后天|周末|下周|下礼拜|周[一二三四五六日天]|礼拜[一二三四五六日天])[^。！？!?\n]{0,16}(有|搞|办|约|攒|组|凑|整)[^。！？!?\n]{0,16}(局|趴|活动|饭局|聚会|聚餐|聚|party|火锅|烧烤|桌游|轰趴|蹦迪|海底捞|打边炉|city\s*walk|citywalk|deep\s*talk|hackathon|一桌)/i,
    reason: '断言具体活动存在 — 必须走 search_events',
  },
  // NOT time-anchored, so the window stays tight to avoid firing on "有个想法".
  {
    id: 'event_count',
    rx: /有(个|场|波|次)[^。！？!?\n]{0,8}(局|趴|饭局|聚会|聚餐|party|桌游|轰趴|海底捞|打边炉)/,
    reason: '断言活动 + 细节存在 — 必须走 search_events',
  },
  // 2. Asserting current opening status — the fast path can't know "now". Synonyms
  //    added after the audit (通宵的 / 开到很晚 / 还在迎客 / 照常出杯 / 24/7).
  {
    id: 'open_now',
    rx: /(还|现在|这会儿|此刻|这点儿?|这个点儿?)[^。！？!?\n]{0,5}(开着|营业|开门|没关|没打烊)|营业到\s*[\d凌晨]|开到\s*(很晚|多晚|半夜|凌晨|\d)|通宵(营业|开门?|的)|还在(营业|迎客|出餐|出杯|颠勺)|照常(营业|出餐|出杯)|没打烊|still\s+open|open\s+now|24\s*\/?\s*7|24\s*(小时|h\b)/i,
    reason: '断言当前营业状态 — fast path 无从知晓',
  },
  // 3. Asserting unverified venues exist — the "有/开了 … 家 … 食肆" structure.
  {
    id: 'venue_assert',
    rx: /(附近|楼下|学校附近|usc\s*附近|旁边|周边)?[^。！？!?\n]{0,6}(有|开了)\s*(好?几|两三|一)?\s*家[^。！？!?\n]{0,12}(馆|店|餐厅|食堂|铺子?|摊|咖啡|奶茶|boba|超市|酒吧|烧腊|烤鸭|卤味|火锅|砂锅|拉面|串串|麻辣烫)/i,
    reason: '断言未经验证的店存在 — 必须走 find_places',
  },
  // 3b. Presupposition venues: "那家/斜对面/楼下 … 食肆" asserts a specific shop
  //     exists WITHOUT the 有…家 structure (audit caught "USC Village 那家川菜馆",
  //     "斜对面那个潮汕砂锅粥"). Food nouns ONLY, so "便利店/书店" don't trip it.
  {
    id: 'venue_named',
    rx: /(那家|那间|那个|斜对面|对面|楼下|巷子里|拐角|东门外|门口|斜坡上)[^。！？!?\n]{0,8}(川菜|粤菜|湘菜|东北菜|火锅|砂锅|粥|拉面|烧腊|烤鸭|卤味|串串|烧烤|麻辣烫|烤肉|奶茶|boba|咖啡|cafe|馆子|餐厅)/i,
    reason: '指代式断言某家具体食肆存在 — 必须走 find_places',
  },
  // 4. Course code — must come from a courses tool, never the fast path. Two
  //    shapes: spaced/hyphenated UPPERCASE ("WRIT 150", "CS-101"; uppercase keeps
  //    "room 150" out) and adjacent any-case ("writ150", "buad280"; adjacency is a
  //    strong course-code signal even lowercase). NOTE: spaced-out letters
  //    ("W R I T 150") and Chinese-numeral codes ("writ 一五零") are a documented
  //    regex ceiling — the prompt rules are the primary defense there.
  {
    id: 'course_code',
    rx: /\b[A-Z]{2,4}\s?-?\s?\d{2,3}[A-Zx]?\b|\b[A-Za-z]{2,4}\d{2,3}[A-Za-z]?\b/,
    reason: '点了课号 — 必须来自 courses 工具',
  },
  // 5. Price — must come from a tool / HOUSING constants. (Chinese-numeral prices
  //    like "一千二" are a documented ceiling; the prompt rule covers them.)
  {
    id: 'price_claim',
    rx: /\$\s?\d|\d+\s*(刀|块钱|块|美金|美元|月租|\/月|rmb|人民币|一个月)/i,
    reason: '点了价格 — 必须来自工具 / HOUSING 常量',
  },
  // 6. Professor + a NUMERIC rating, either order. Requiring the number is what
  //    keeps a generic OFFER to look ratings up ("帮你查哪个教授评分高") from bailing
  //    — the audit caught the bare-"评分" version over-firing on offers.
  {
    id: 'prof_rating',
    rx: /(教授|professor|prof|老师|教这门?的)[^。！？!?\n]{0,14}(\d\.\d|rmp\s*\d|评分\s*\d|打\s*\d|\d\s*星)|(\d\.\d|rmp\s*\d|评分\s*\d)[^。！？!?\n]{0,10}(教授|professor|prof|老师)/i,
    reason: '断言教授评分 — 必须来自 get_rmp_ratings',
  },
];

// Place names George legitimately knows, masked to ∎ before scanning so a known
// landmark adjacent to a verb can't seed a false venue/course hit. Built from the
// alias table plus a few BIA-lore brands not in it.
const SAFE_PLACES: string[] = (() => {
  const names = new Set<string>();
  for (const a of ALIASES) {
    if (a.canonical) names.add(a.canonical.toLowerCase());
    for (const v of a.variants) if (v) names.add(v.toLowerCase());
  }
  for (const extra of [
    'trader joe', "trader joe's", "trader joe’s", 'h mart', 'hmart', '99 ranch',
    '大华', 'usc village', '村子', 'target', 'starbucks', '星巴克', 'in-n-out',
    'in n out', '7-eleven', 'costco', 'chipotle', 'panda express',
  ]) names.add(extra);
  // Longest first so "usc village" masks before "village".
  return Array.from(names)
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
})();

function maskSafePlaces(text: string): string {
  let out = text;
  for (const name of SAFE_PLACES) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'gi'), '∎');
  }
  return out;
}

// The clause containing `index`, bounded by sentence/clause punctuation. Used to
// scope offer-suppression so an offer doesn't excuse a separate assertion.
function clauseOf(text: string, index: number): string {
  const seps = /[。！？!?\n;；，,、]/g;
  let start = 0;
  let end = text.length;
  let m: RegExpExecArray | null;
  while ((m = seps.exec(text)) !== null) {
    if (m.index < index) start = m.index + 1;
    else {
      end = m.index;
      break;
    }
  }
  return text.slice(start, end);
}

// Scans a fast-path draft for asserted-fact fabrication. Returns the hits (empty
// = safe to send). Pure + synchronous; no I/O, so it never throws on its own.
export function scanFabricationRisk(text: string): FabricationHit[] {
  if (!text) return [];
  const masked = maskSafePlaces(text);
  const hits: FabricationHit[] = [];
  for (const { id, rx, reason } of RISK_PATTERNS) {
    const m = rx.exec(masked);
    if (!m) continue;
    // Offer-suppression: an offerable hit inside an "I'll look it up" clause is an
    // offer, not an assertion — keep the warm reply rather than bail.
    if (OFFERABLE.has(id)) {
      const clause = clauseOf(masked, m.index);
      if (OFFER_RX.test(clause)) continue;
    }
    hits.push({ id, reason, match: m[0] });
  }
  return hits;
}

// --- Full-agent backstop (P1-B) ----------------------------------------------
// Detects a citation or course code emitted on a turn where NO tool ran and NO
// sub-agent was dispatched — i.e. the model answered from its own head but
// dressed it with "(source: …)" authority (the eval caught "MUSC 102 … (source:
// usc catalogue)"). Conservative on purpose: only the fake citation parenthetical
// is stripped (safe, bounded); a bare course code is reported but left in place,
// since blind mid-sentence deletion of a code risks mangling a legit reply. The
// caller gates this on "no tool AND no dispatch" so a real grounded turn is never
// touched.
const CITATION_RX = /[(（]\s*(source|来源|出处|src|来源链接)\s*[:：][^)）]*[)）]/gi;

export function detectUnsourcedClaim(text: string): {
  hit: boolean;
  ids: string[];
  cleaned: string;
} {
  const ids: string[] = [];
  // Fresh literal each use so the /g lastIndex never leaks between calls.
  const hasCite = /[(（]\s*(source|来源|出处|src|来源链接)\s*[:：][^)）]*[)）]/i.test(text);
  if (hasCite) ids.push('fake_citation');
  if (/\b[A-Z]{2,4}\s?-?\s?\d{2,3}[A-Zx]?\b|\b[A-Za-z]{2,4}\d{2,3}[A-Za-z]?\b/.test(text)) {
    ids.push('course_code');
  }
  const cleaned = hasCite
    ? text
        .replace(CITATION_RX, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([。！？!?,，])/g, '$1')
        .trim()
    : text;
  return { hit: ids.length > 0, ids, cleaned };
}
