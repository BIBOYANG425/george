# 修复 plan：豆包 fast-path 反编造护栏（+ 顺带修 full-agent 编造）

**日期：** 2026-06-20
**触发：** 6-persona A/B 评测（`wf_85345473`）裁定豆包 fast-path *净判定偏负* — 暖度真实但靠"编造具体事实"换来，6/12 情绪回复编造了不存在的局/店/营业时间，命中 AGENT.md 反编造红线。
**一句话目标：** 让豆包**保持暖**，但一旦伸手去够具体店名/活动/营业时间/课号/价格，立刻**硬 BAIL 给 grounded 的 full agent** —— 那才是可以上线的版本。

---

## 0. 设计原则（先定调，后面所有改动服从这 4 条）

1. **不让豆包变冷。** 评测确认暖度优势是真的（豆包 4.3 vs 老路 3.8，且是"真共情"不是注水）。修复的目标不是削弱语气，是**只拦掉编造的那一小撮**。
2. **护栏是代码，不是提示。** `FAST_INSTRUCTION` 已经写了"Never invent a fact"，豆包照编。模型自我监管不可信 → 必须在**出稿后做代码层扫描**，命中即丢弃草稿、转 full agent。
3. **recall-biased（宁可错杀）。** fast-path 误判 bail 的代价 = 这一条慢几秒走 full agent（拿到 grounded 答案）；漏判的代价 = 假信息发给最脆弱的用户。两者不对等 → 扫描器**偏向多 bail**。
4. **offer ≠ assert。** "帮你查查有没有粤菜馆"（合法）和"附近有几家粤菜馆能吃出家里味道"（违法）必须在 prompt + 扫描器里都区分开。

---

## 1. 当前代码现状（grounded，改动前的事实）

| 事实 | 位置 | 影响 |
|---|---|---|
| 豆包 fast-path 已合并 main | `src/agent/fast-path.ts` @ commit `e960a30`；`src/agent/doubao-client.ts` @ `d962c02` | 修复落在 main 之上 |
| fast-path **无任何代码层后置检查** | `fastReply()` 只在 `text.includes(NEEDS_AGENT)` 时 bail | 这是要加护栏的位置 |
| `voiceLint()` 是**死代码** | `src/agent/bia-lore.ts:213`，全项目 grep 无调用方 | 可复用，但要先接进回复路径 |
| `ANTI_PATTERNS` 已含 markdown/好问题 正则 | `bia-lore.ts:177-179`（bold/bullet/heading）、`:144`（great_question） | P2 findings 的正则已存在，只差接线 |
| `stripMarkdown()` 新增、未接线 | `src/adapters/strip-markdown.ts`（untracked，在 latency 分支） | markdown 用它清洗，不用 bail |
| orchestrator 已跟踪本轮 tool 名 | `src/agent/orchestrator.ts:399` `const turnTools = new Set<string>()` | full-agent 编造校验可复用它 |
| 分支分叉 | 当前 `feat/latency-and-admin-dashboard` 无豆包；豆包在 main | **见 §6 前提** |

---

## 2. 修复分层（按优先级；P0 是上线闸门）

### P0-A — fast-path 反编造扫描器（决定性护栏）

**新文件 `src/agent/fast-path-guard.ts`：**

```ts
// 出稿后扫描：豆包/任何 fast 模型若伸手去够具体事实，返回命中项；fastReply 即 bail。
export interface FabricationHit { id: string; reason: string; match: string }

const RISK_PATTERNS: Array<{ id: string; rx: RegExp; reason: string }> = [
  // 1. 断言存在一个具体活动/局（最严重 —— spec 点名要 BAIL）
  { id: 'event_assert',
    rx: /(这周|本周|这礼拜|今晚|今天|明天|后天|周末|周[一二三四五六日天]).{0,10}(有|搞|办|约|攒).{0,6}(局|趴|活动|饭局|聚|party|火锅|饭|聚餐)/,
    reason: '断言具体活动存在 —— 必须走 search_events' },
  { id: 'event_count',
    rx: /有(个|场|波|次).{0,4}\d*\s*(人|位)?的?(局|趴|活动|饭局|聚)/,
    reason: '断言活动 + 人数/细节' },
  // 2. 营业时间 / "现在还开着"
  { id: 'open_now',
    rx: /(还|现在|这会儿|此刻|这点).{0,5}(开着|营业|开门|没关)|营业到\s*\d|开到\s*\d|still\s+open|open\s+now|24\s*小时/i,
    reason: '断言当前营业状态 —— fast path 无从知晓' },
  // 3. 断言存在具体餐厅/店（allow-list 之外）
  { id: 'venue_assert',
    rx: /(附近|楼下|学校附近|usc附近|旁边)?\s*(有|开了)\s*(好?几)?\s*家.{0,12}(馆|店|餐厅|铺|摊|咖啡|奶茶|boba|食堂|超市)/,
    reason: '断言未经验证的店存在' },
  // 4. 课号
  { id: 'course_code',
    rx: /\b[A-Z]{2,4}\s?-?\s?\d{2,3}[A-Zx]?\b/,
    reason: '点了课号 —— 必须来自 courses 工具' },
  // 5. 价格
  { id: 'price_claim',
    rx: /\$\s?\d|\d+\s*(刀|块钱|块|美金|美元|月租|\/月|rmb|人民币)/i,
    reason: '点了价格 —— 必须来自工具/HOUSING 常量' },
  // 6. 教授名 + 评分
  { id: 'prof_rating',
    rx: /(教授|professor|prof|老师).{0,12}(\d\.\d|rmp|评分|rate)/i,
    reason: '断言教授评分' },
];

// allow-list：George 合法知道、可以点名的地点（USC_LOCATIONS_ZH + HOUSING_NEIGHBORHOODS
// + usc-aliases 拼出）。扫描前先把它们 mask 掉，避免 "去 Leavey 三楼" / "K-town" 误伤。
function maskSafePlaces(text: string): string { /* replace allow-listed names with ∎ */ }

export function scanFabricationRisk(text: string): FabricationHit[] {
  const masked = maskSafePlaces(text);
  const hits: FabricationHit[] = [];
  for (const { id, rx, reason } of RISK_PATTERNS) {
    const m = masked.match(rx);
    if (m) hits.push({ id, reason, match: m[0] });
  }
  return hits;
}
```

**接线 `src/agent/fast-path.ts`（`fastReply` 返回前）：**

```ts
const text = (raw ?? '').trim();
if (!text || text.toUpperCase().includes(NEEDS_AGENT)) return null;
// 代码层反编造闸：模型（尤其豆包）无视 "never invent"，会去够具体店/局/营业时间/课号/价。
// 不能信自我监管，所以扫描草稿；任何"够具体事实"即 bail 到 grounded full agent。
// recall-biased：错杀只是慢几秒。
if (config.fastPathFabricationGuard) {
  const hits = scanFabricationRisk(text);
  if (hits.length) {
    log('info', 'fast_path_fabrication_bail', { ids: hits.map((h) => h.id), sample: hits[0].match });
    return null;
  }
}
return text;
```

**`src/config.ts`：** `fastPathFabricationGuard: process.env.FASTPATH_FABRICATION_GUARD !== 'false'`（默认 **ON**；留一个 kill-switch）。

> 为什么是"扫描 + bail"而不是"让豆包重写一遍去掉事实"：重写多一次往返、且豆包可能再编一次。硬 bail 简单、安全、确定性。重写是次选，先不做。

### P0-B — offer-vs-assert 提示 + few-shot（配套）

改 `fast-path.ts` 的 `FAST_INSTRUCTION`，新增一段（同时同步进 `prompts/master.md` 的 fast-path/反编造段，保持单一事实源）：

```
# 暖路上的反编造（关键）
- 你可以暖、可以 offer 去帮忙找："我帮你看看有没有合适的粤菜馆" —— 合法。
- 你不可以断言某个具体的店/活动/时间存在：
    "附近有几家粤菜馆能吃出家里味道" / "bia这周有个四人火锅局" / "in-n-out 现在还开着"
  —— 全部禁止，这些是你本该查的事实。
- 暖的动作一旦需要点名真实的餐厅/活动/营业状态/课/教授/价格 → 要么输出 NEEDS_AGENT，
  要么保持暖但不带那个事实（"陪你扯扯淡" / "我帮你查查这点还开着的地儿"）。
- 口诀：offer 去找 = 合法；断言存在 = 违法。
```

加 2 条 few-shot（正中评测失败的两个 persona）：

- **想家** → ❌"usc 附近有几家粤菜馆烧腊很正" → ✅"想家的时候胃比脑子先投降😢 想吃粤菜的话我帮你扒一下附近靠谱的，要不要"
- **凌晨饿** → ❌"楼下 in-n-out 现在还开着" → ✅"三点多这个点儿能 walk-in 的真不多了🥲 我帮你查查这会儿还开着的，别空着肚子睡"

### P1-A — 把 voiceLint 接进**两条**回复路径（治死代码 + 收 markdown/banned）

`voiceLint` 当前没人调。接线策略**按违规类型分级**，不要一刀切 bail（否则会因为一个 markdown bullet 丢掉一个 grounded 答案）：

- **markdown 类**（`markdown_bold/bullet/heading`、em-dash）→ 跑 `stripMarkdown()` 清洗后照发，不 bail。
- **banned-phrase 类**（`great_question`/`好问题`、AI-slop、ghost 残留）→ 记 telemetry；fast-path 上可直接 bail（让 full agent 重答），full-agent 上记日志 + 清洗（不丢答案）。
- 在 orchestrator 出稿点（fast-path `:348`、full-agent 结果处）各加一道 `voiceLint` + `stripMarkdown`。

### P1-B — full-agent 编造（独立 bug，与豆包无关，但同样紧急）

评测发现 full agent 自己编了 `MUSC 102 / ART 141` 还贴假的 `(来源: usc catalogue)`。两手：

1. **提示硬规则**（`prompts/master.md` + `prompts/know-things.md`）：课号 / 课名 / 教授名 / 价格 / 营业时间 / 奖项**只能来自本轮真实 tool 调用结果**，不能凭记忆。没调工具就别点名 → "戳到知识盲区了😢" + 先问 major/year + 调工具。禁止编造 `(来源:…)`。
2. **代码层校验**（复用 orchestrator 已有的 `turnTools`）：full-agent 出稿后，若回复含课号正则 / `(来源` / `catalogue` 但**本轮没调过任何 courses/knowledge 工具** → 记 `full_agent_unsourced_claim` 日志，并在回复尾部去掉假引用 / 追加一句 hedge。这是可落地的"假来源"探测，比纯正则判断真假强。

### P2 — 收紧并固化（低优先，跟随 P1-A 一起）

- markdown/`好问题` 既然正则已在 `ANTI_PATTERNS`，P1-A 接线后它们自动生效；补一条 snapshot 测试锁住。
- `bia-lore.ts` 的注释说 voiceLint "optionally by a post-hoc regex guard in runSubAgent" —— 落实这句，别再让它停在注释。

---

## 3. 改动文件清单

| 文件 | 改动 | 层 |
|---|---|---|
| `src/agent/fast-path-guard.ts` | **新增** `scanFabricationRisk` + allow-list mask | P0-A |
| `src/agent/fast-path.ts` | 出稿后接扫描器；`FAST_INSTRUCTION` 加 offer/assert 段 + 2 few-shot | P0-A/B |
| `src/config.ts` | 加 `fastPathFabricationGuard` flag | P0-A |
| `prompts/master.md` | 同步 offer/assert 规则；加 full-agent "事实只能来自工具" 硬规则 | P0-B / P1-B |
| `prompts/know-things.md` | 课号/教授/价格只能来自工具；禁编 `(来源:)` | P1-B |
| `src/agent/orchestrator.ts` | 两条路径接 `voiceLint` + `stripMarkdown`；full-agent `turnTools` 假来源校验 | P1-A/B |
| `src/agent/bia-lore.ts` | （可选）给 fabrication 类加几条 `ANTI_PATTERNS`，或保持都在 guard 里 | P1 |
| `test/*` | 扫描器单测（每条 RISK_PATTERN 命中 + allow-list 不误伤）、voiceLint snapshot | 全 |

---

## 4. 验证（量化成功标准，复用现成评测 harness）

评测脚本已在 `/tmp/george-eval/scripts/_eval.ts`（6 persona × [2 情绪 A/B + 1 查事实]）。改完**重跑同一套**，判定通过当且仅当：

- **豆包情绪编造数：6/12 → 0/12**（扫描器把所有编造草稿 bail 掉）。
- **豆包暖度不塌：均分 ≥ 4.0**（确认护栏没把它改冷；尤其 visa/social 两个干净胜例要保持）。
- **bail 后的体验可接受**：被 bail 的那几条走 full agent 后给出 grounded 答案或安全暖话，不是干巴巴的"我去查"。
- **full-agent grounding：3/6 → 6/6**（cs-burnout 不再编课号、想家不再贴假来源）。
- 新增**对抗用例**：直接问 fast-path "今晚有啥局 / in-n-out 开着吗 / writ150 选谁" —— 必须 100% bail，0 直接断言。

---

## 5. 灰度 / 回滚

- **永不裸上豆包。** 豆包 + 护栏**同一次**上线。`FASTPATH_FABRICATION_GUARD` 默认 ON。
- 后端（Bobby）无需改动即可回退：设 `FASTPATH_FABRICATION_GUARD=false` 关护栏，或清空 `DOUBAO_*` 整段回落老路（已有自动 fallback）。
- 观测：盯 `fast_path_fabrication_bail` 日志频率。频率过高 = 扫描器太激进（误杀多、延迟升），按 id 收紧；频率为 0 而仍见编造 = 漏了 pattern，补正则。

---

## 6. 前提：先把分支理顺

当前工作树 `feat/latency-and-admin-dashboard` **不含豆包**（豆包在 main 的 `e960a30`）。护栏代码改的是豆包版 `fast-path.ts`，所以**先确认基线**：

- 若 latency/dashboard 分支还要继续：先 `git merge origin/main`（或 rebase）把豆包 + memory-fix 拉进来，再在其上做护栏 —— 否则改的是没豆包的 fast-path，白改。
- 若直接在 main 上开 `fix/fastpath-antifabrication` 分支：最干净，推荐。护栏与 latency/dashboard 解耦。

---

## 7. 工单拆分（建议 2 个 PR）

- **PR-1（上线闸门，P0+P1-A）：** `fast-path-guard.ts` + fast-path 接线 + config flag + offer/assert 提示 + voiceLint/stripMarkdown 接线 + 扫描器单测。**这一个 PR 合了，豆包才算可上线。**
- **PR-2（独立，P1-B）：** full-agent 反编造（提示硬规则 + `turnTools` 假来源校验 + know-things.md）。与豆包解耦，可并行。

---

## 8. 风险 / 权衡

| 风险 | 缓解 |
|---|---|
| 扫描器误杀，fast-path 退化成"什么都 bail"、延迟升回 50s | recall-biased 是有意的；用 `fast_path_fabrication_bail` 频率监控，按 id 收紧；allow-list 覆盖 George 合法地点 |
| 正则漏判仍编造 | 对抗用例 + 评测把关；漏了补 pattern（增量便宜） |
| markdown 强清洗破坏正常文本（`foo_bar`、裸 `*`） | `stripMarkdown` 已是保守实现（只清成对标记、跳过标识符内下划线） |
| 提示加 few-shot 把豆包"教"得过度保守、连纯共情也 bail | 评测的"暖度 ≥4.0"门槛专门兜这个；few-shot 给的是 ✅ 暖样例，不是只给 ❌ |
| 假来源校验对长答案有性能开销 | 只在 full-agent 出稿一次、纯正则，开销可忽略 |

---

## 9. 给创始人一句话

豆包的暖值得留。它现在是靠编你不让它编的东西换来的暖。**加一道"碰到具体店/局/营业时间就硬转 agent"的代码闸（PR-1），豆包就能既暖又不骗人。** 闸没上之前，孤独新生和凌晨饿的人是最先被假信息伤到的，而他们恰恰是 George 最不能搞砸的用户。

---

## 10. 实现 + 验证记录（2026-06-20 执行）

**分支更正（plan §1/§6 的前提是错的）：** 豆包并未合并 `main`，而是在 `feat/doubao-fastpath`（一个删掉 `bia-lore.ts` 的大型 restructure 分支）。当前 `feat/latency-and-admin-dashboard` 是唯一一个 `fast-path.ts` / `bia-lore.ts`(voiceLint) / `strip-markdown.ts` / `master.md` / `know-things.md` / orchestrator `turnTools` 全部共存的分支，所以护栏实现落在这里。扫描器是 model-agnostic 的出稿后文本扫描，原样可移植到豆包版 `fast-path.ts`（同样 3 段插在 `return text` 前）。

**已落地：**
- `src/agent/fast-path-guard.ts`（新）：`scanFabricationRisk`（7 类 pattern + allow-list mask + 子句级 offer-suppression）+ `detectUnsourcedClaim`（full-agent 假引用探测）。
- `src/agent/fast-path.ts`：出稿后接扫描器（命中即 bail）+ `voiceLint` 接线（AI-slop/ghost 残留 bail，markdown/em-dash 交给 presentation 层）+ `FAST_INSTRUCTION` 加 offer/assert 段 + 2 few-shot；never-stall 规则重写为「只拦事实问题的 stall，温柔的 offer 不算」。
- `src/config.ts`：`FASTPATH_FABRICATION_GUARD`（默认 ON，kill-switch）。
- `src/agent/orchestrator.ts`：result 消息处加 full-agent 假引用 backstop，门控在「本轮零工具 且 零 sub-agent dispatch」（最低误报）。
- `prompts/master.md` + `prompts/know-things.md`：offer≠assert + 「事实只能来自本轮工具」+ 引用必须对应真实 tool 结果（删掉了原 know-things「Always cite」的反射式假引用诱因）。
- `tests/agent/fast-path-guard.test.ts`（新）：42 条单测。

**两个超出 plan 原文的设计修正（plan 的正则有 bug）：**
1. plan 的 `open_now` 正则会**误杀 plan 自己的 ✅ 示例**「我帮你查查这会儿还开着的」（offer）。加了子句级 offer-suppression，offer 留、断言 bail，正确编码原则 4。
2. `course_code` 原只认大写，漏 `writ150`/`buad280`；扩成大写带空格 + 任意大小写相邻两种形态。

**验证（确定性，可复跑）：**
- `tsc --noEmit`：通过。`vitest run`：**507 passed / 0 failed**（含仓库自带 em-dash voice 守卫，它抓出并让我修掉了 prompt 编辑里真实的 em-dash 残留）。
- **对抗评测**（workflow `wf_a4d53363`，10 个 persona 生成器含 red-team 规避角度，142 条带标签语料，跑真实扫描器打分）：
  - **Recall（编造被拦）：61.7% → 86.7%**（调正则后）。
  - **False-positive（暖回复被误杀）：2.4% → 0.0%**。
  - 剩余 8 条漏判**全部来自 adversarial-evasion**（"W R I T 150" 拆字、"一千二/四点九" 中文数字、"门没锁灯还亮着" 同义改写）——即**自然措辞的编造 100% 被拦**。这 8 条是已记录的正则天花板（prompt 层 + full-agent grounding 是这里的防线；用正则追中文数字会在日常夸张语（"等了一千年"）上重新引入误报）。

**未做（按 plan 拆单，解耦）：** 豆包分支合并时把同样 3 段护栏插进豆包版 `fast-path.ts`（一行级移植）；live 6-persona A/B 评测复跑（需 API key + 豆包分支，属 PR 验收步骤）。

---

## 11. 重新移植到 main（2026-06-21，#48 已合并后）

**情况变了:** PR #48(`feat/doubao-fastpath`)已被 Bobby merge 进 `main`，**豆包已上线但没带护栏** —— 正是 plan 禁止的"裸上豆包"。同分支还删了 `bia-lore.ts`、换成 slim 的 `voice-guard.ts`。原护栏分支建在旧的 pre-doubao fast-path 上，对不上，故从 `origin/main` 重开 `fix/doubao-antifabrication-guard` 重新移植。

**移植结果(8 文件,+696/−7):**
- `fast-path-guard.ts` / 测试 / plan：原样搬过来。
- `fast-path.ts`(豆包版)：接扫描器(`return text` 前,出稿点结构与旧版一致)+ offer/assert FAST_INSTRUCTION + never-stall 重写。
- `config.ts`：加 `FASTPATH_FABRICATION_GUARD`。
- `orchestrator.ts`：result block 加 full-agent 假引用 backstop（结构与旧版一致）。
- `master.md`：只加一条 offer/assert bullet（main 的 master.md 已有更好的 "Source on demand" 规则,不重复）。
- `know-things.md`：修一个**真实矛盾** —— main 的 know-things 仍写 "Always cite for factual claims"，和 master.md 的 "Don't tack (source:X) onto every reply" 直接打架,正是假引用的诱因。改成"只在调过工具/被问到时才引用"。

**两个有意的偏差(批判性决定):**
1. **没移植 fast-path 的 voiceLint bail** —— 它依赖的 `bia-lore.ts` 已删,替代的 `voice-guard.ts` 只剩 em-dash + 不是…而是 两条硬禁且只用于 proactive；为一个 em-dash 把暖回复整条 bail 到 full agent 是坏交易。markdown 仍在 presentation 层 strip,所以这块无损。
2. **prompt 改动避开 em-dash + 不是…而是**（voice-guard 会禁的两条 tell）。

**验证:** `tsc` 通过。`vitest`：790 passed，唯一 1 failed 是 `relationship.test.ts` 期望 SMART tier 含 'sonnet'，但本地 `.env` 把 `GEORGE_MODEL_SMART` 设成了 `claude-opus-4-8` —— 在干净 `origin/main` 上同样 fail，是本地 env 产物，与本 PR 无关，CI 用默认 sonnet 不受影响。对抗评测(142 例)：recall 86.7% / FP 0.0%，与移植前一致。
