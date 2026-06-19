# George 数据平台下一章：Dashboard + Analytics + 每人不同模型

> Architect's thinking doc (2026-06-17). 由一次 grounded 多agent深度思考产出：6 维系统测绘 → 6 条设计线 → 对抗式 stress-test → 综合，再经 completeness critic 校正（已把校正合入正文，校正点标 `[critic]`）。
> 隐私/治理 track 有否决权 — gate 下面一切。

---

## 1. 一句话结论

**先把每一轮对话的 telemetry 写进一张独立的、按 PII 对待的 `turn_telemetry` 账本（数据已经在 `orchestrator.ts` 的 SDK `result` message 里、现在被直接丢掉了），其余一切——dashboard、模型 re-evaluation、每人不同模型——都是这张账本的下游，必须排在它后面；"接入模型做神经领域研究"在这个产品里不是真东西，诚实的版本是 model bake-off + per-cohort 重评估。**

---

## 2. 现状盘点

George 今天是一个纯 Express API backend，~15 张表、12 个 migration（last applied `2026-06-11`），persona 完整、对话能 replay，但**几乎没有任何可用于分析的 telemetry**。四个 load-bearing 缺口：

**(1) 被丢掉的 telemetry — root cause。**
`messages` 表 schema 里有 `agent` / `tokens_used` / `tool_calls` 三列（`001_george_schema.sql`），但生产写路径 `src/agent/session-store.ts:82-87` 只 insert `{user_id, role, content, created_at}`，这三列在生产 100% 是 NULL。能填它们的 `src/db/messages.ts` `saveMessage()` 是**死代码、无 caller**。更关键：`src/agent/orchestrator.ts` 的 for-await loop 已经拿到 SDK `result` message 的 `m.usage`，但**只读了 `usage.server_tool_use.web_search_requests`，其余全丢**。v0.3.168 的 `SDKResultSuccess` 直接给 `total_cost_usd`、`duration_ms`、`duration_api_ms`、`modelUsage: Record<string, ModelUsage>`（per-model 的 input/output/cacheRead tokens + costUSD）。**Claude 路径的成本是 SDK 算好递给你的，不必自建 pricing table。**

**(2) 全局模型选择，无 per-user seam。**
`src/agent/agents.config.ts:30-31` 在 **module load** 时把 `FAST_MODEL`(haiku-4-5)/`SMART_MODEL`(sonnet-4-6) 绑死。`orchestrator.ts` header 自己标注 "agents.config will need to become a per-invocation factory"。`query()` 调用**没有 `model` 字段**，orchestrator 跑在 SDK default 上。另有 4 处硬编码：`squad-draft.ts`、`llm-clients.ts`(`deepseek-chat`)、`llm-providers.ts`(haiku / `moonshot-v1-8k`)。

**(3) 日志只在 console，不落库。**
`src/observability/logger.ts` 的 `log()` 只 `console.log` JSON，容器重启即丢。`getStats()` 只有 7 个 COUNT 聚合，没有 latency / cost / per-agent / refusal rate。唯一持久化的结构化审计表是 `heartbeat_log`(013) 和 `proactive_log`(001)，前者只有 `outcome`+`duration_ms`，后者只有 `status`，都没有 tokens/cost。**`heartbeat_log` 注释承诺的 90 天 GC cron 从未实现**（013 那行只是 COMMENT）——这是本codebase上 in-process retention 静默失败的直接前科。`[critic]`

**(4) 单一 `ADMIN_TOKEN` + prod-PII 危险。**
`adminAuth` 只是 bearer 字符串比对，**无 per-admin 身份、无 role、无审计**。`SUPABASE_JWT_SECRET`、`jsonwebtoken` 在 repo 里**都不存在**。`user_profiles` / `user_heartbeat_instructions` 含高保真 PII（专业、居住、关系），RLS 开了但 service-role 全 bypass。本地 dev 直连**真实 prod Supabase**（CLAUDE.md + user memory 都标了此 hazard），无 staging 库。`/delete me` 只删 6 张硬编码表。

**两个会咬人的次级事实：**
- **双键问题：** `messages`/telemetry 按 `user_id`(text handle = 手机号/email/openId) 键；`proactive_log`/`heartbeat_log` 按 `student_id`(uuid) 键，且 `student_id` 在 onboarding 前为 NULL。跨表 JOIN 会静默丢行。
- **`admin_audit_log` 已存在且会撞车：** `user-command-router.ts:75` 已往 `admin_audit_log` 写 `{actor_email, action, entity_type, entity_id, payload}`，`/delete me` 的审计依赖它。任何"新建 admin_audit_log"的 migration 会撞车并破坏现有删除审计。**但注意：现存每条写入都硬编码 `actor_email='system@george'`，表里没有可区分的 actor** —— 复用它能避免 schema 冲突，但 per-admin 问责仍 block 在未建的 auth stack 上。`[critic]`

---

## 3. 目标架构

```
                  ┌─────────────────────────────────────────────────────────┐
                  │  george (Express, API-only)                             │
  reactive turn   │   runOrchestrator()  ← THE single chokepoint           │
  (6 entry pts)   │     ├─ resolveModels(ctx)   [Phase 3: model-router]    │
  ──────────────► │     ├─ query({ model, maxBudgetUsd })                  │
  /chat           │     ├─ reads total_cost_usd / modelUsage / duration    │
  /chat/stream    │     │   + is_error/subtype (success AND error branch)  │
  Path B incoming │     └─ void recordTurn({...})  ← fire-and-forget       │
  spectrum        │              │  (abort/supersede 也写一行)              │
  wechat          │              ▼                                          │
  legacy imessage │   src/db/telemetry.ts (service-role, src/db/* only)    │
  ─ ─ ─ ─ ─ ─ ─ ─ │   heartbeat / proactive / squad-draft  ─► recordTurn  │
                  └──────────────┼──────────────────────────────────────────┘
                                 ▼ INSERT (append-only, PII-bearing, flag-gated)
        ┌────────────────────────────────────────────────────────────┐
        │  turn_telemetry  (bia-admin migration, RLS service_role)    │
        │  user_id text · student_id uuid(write-time stamp) · channel │
        │  · model_used · modelUsage(jsonb) · tokens · cost_usd       │
        │  · latency · sub_agent · tool names · turn_outcome          │
        │  · is_error/subtype · NO message content                    │
        └───────────┬──────────────────────────┬─────────────────────┘
                    │ daily rollup (pg_cron)    │ ≤90d raw (DB-side GC)
                    ▼                          ▼
        turn_telemetry_daily         offline eval harness (npm run eval)
                    │                          │  golden set + scorers + bake-off
                    ▼                          ▼
   george /admin/analytics/* (aggregate-only, authed)    model re-eval decision
                    │                                              │
                    ▼                                              ▼
        bia-admin dashboard (Next.js, admin.uscbia.com)   user_model_config (Phase 3)
        read-only v0 → quality panels → model-assign UI    drives resolveModels()
```

**数据流主轴：** 一个 chokepoint(`runOrchestrator`) → 一张 PII-bearing 账本 → daily rollup + 90 天 raw → george 聚合 read API → bia-admin 只读 dashboard → 离线 eval 喂 re-evaluation → `user_model_config` 驱动 per-user 路由。每一段都 flag-gated，半落地退化为 NULL/no-op，绝不打断 `/chat`。

---

## 4. 六条设计线的整合结论

### 4.1 Telemetry（数据地基）— **做，写入点收敛到 `runOrchestrator` 内部一个 `recordTurn`**

- **不要"yield event 让 6 个 caller 消费"。** spectrum/wechat/legacy-imessage 都走 `runOrchestratorText` wrapper（返回 `Promise<string>`），改 wrapper 契约要动所有 call site。**正确做法：`runOrchestrator` 自己在 loop 结束前调一次 `recordTurn`** —— 它已持有 `userId`/`channel`/`studentId`，且已摸到 result message。单一写者，真 chokepoint，不碰 4 个 adapter。
- **直接读 SDK 给的 `total_cost_usd` + `modelUsage`**，丢掉手搓 Claude pricing table。
- **`[critic]` per-tier 成本在 Phase 0 就拿得到，别整张 DEFER。** `modelUsage` 是 **按 model 串** keyed 的，而 George 的 agent 故意分层（haiku=FAST 两个 sub-agent / sonnet=SMART 的 know-things / orchestrator=default）。所以同一 turn 内 `modelUsage` 能拆出 haiku-cost vs sonnet-cost —— 这是可用（虽粗）的 per-tier/per-agent-class 代理。**把 `modelUsage` 原样存成 JSONB 列（result 里免费）**，诚实标注"per-model 精确；per-agent 近似（orchestrator 与同层 sub-agent 共享 model key）"。
- **`[critic]` recordTurn 必须覆盖 error / abort 分支。** SDK 有独立的 `SDKResultError`（`error_max_turns` / `error_max_budget_usd` / `error_during_execution`…，**无 result string**，但仍带 `total_cost_usd`+`modelUsage`）。Spectrum 的 supersede/abort 路径 `AbortController` 中途触发，**根本没有 result message**。这些恰恰是最该记的 turn（成本炸、超时、被打断）。`recordTurn` 显式记 `is_error`/`subtype`/`stop_reason`/`turn_outcome`；abort/supersede 从 catch/abort handler 写一行 `outcome='aborted'`，否则 95% 覆盖率的分母会把失败 turn 排除掉、latency/cost 被系统性低估。
- **`[critic]` 写入时直接 stamp `student_id`**（`runOrchestrator` 已解析它），避免 Phase 1 用 user_id↔student_id 做有损 JOIN（见 §2 双键问题）。
- **不叫 "content-free" 就当无 PII** —— `user_id` 是手机号，是直接标识符。整张表按 PII 对待，见 §5。

**Where it lives:** `turn_telemetry`+`turn_telemetry_daily` migration 在 bia-admin；`src/db/telemetry.ts` + orchestrator instrumentation + rollup/GC 在 george。**Effort:** 核心 recordTurn = **M**；跨 provider(DeepSeek/Kimi 需手搓 pricing) + rollup = **M**。

### 4.2 Dashboard — **做，但先跑 SDK spike，auth 与 telemetry 解耦**

- **Phase 1（telemetry capture）对 auth 改造零依赖 —— 单独先发。**
- **GREP before migrate：** 复用现有 `admin_audit_log`，**不要** CREATE 冲突表。
- **auth 是 research 任务不是 "M"：** `SUPABASE_JWT_SECRET`、`jsonwebtoken` 不存在，bia-admin 真实 auth stack 未确认 —— 先确认再设计 `adminJwtAuth`。
- **聚合端点零 PII；live feed 的 handle 必须在 API 层 hash/截断**（不能在 UI 层），否则 viewer-role 直接看到手机号、绕过 audit-gated drilldown。
- **"real-time" = 10–15s 轮询**，不是 SSE/Realtime —— 单 Express 进程 + Cloudflare Container 不适合长连接。
- **percentile 不在 live 进程上裸跑无界表：** dashboard 读 `turn_telemetry_daily` rollup，research 读 ≤90 天 raw。
- **`[critic]` Phase 1 读路径别 JOIN 三表。** telemetry(user_id) 与 proactive/heartbeat(student_id, onboarding 前 NULL) 一 JOIN 就静默丢行。要么 (a) 三个来源各自成 panel、v0 永不 JOIN；要么 (b) 靠 4.1 的 write-time `student_id` stamp 走干净的等值连接。

**Where it lives:** george `/admin/analytics/*` + bia-admin `/george/dashboard`。**Effort:** 每组件 **M→L**、跨 repo 多周。

### 4.3 Eval pipeline — **做离线 harness，把"数据飞轮"和"神经领域研究"砍出去**

- **先跑一个 SDK spike（一下午）：** log 一个 know-things turn 的原始 message stream，确认 sub-agent 的 `tool_result` payload 和 sub-agent-name marker 是否可见。**anti-fabrication 和 routing-accuracy 全压在这个 spike 上。**
- **anti-fabrication v1 只对已知常量**（`HOUSING_NEIGHBORHOODS`、flagship events）做 string-presence；对 `$金额`/RMP评分/`COURSE 123`/日期 pattern **flag-for-human-review**。在 spike 证明能拿到 tool output 前，删掉"对照 captured tool outputs 校验"的承诺。
- **bake-off 必须显式把 orchestrator model 注入 `query()` options**，光靠 `GEORGE_MODEL_SMART` 只换 sub-agent，会 confound 比较。
- **golden set 先 synthetic**（从 AGENT.md playbook + master.md few-shots），让 Bobby 裁定 ~40 条做 labeling oracle，`MANIFEST.json` 冻结版本。
- **真实对话 export 飞轮从这条线砍出去** —— 它需要 NER 级 redactor（现有 `redactDigits()` 只遮数字，遮不掉姓名/email/专业/关系）、`research_consent` migration、founder 对 judge-API egress 的签字。独立、consent-gated 项目，不是 weeks-scale。

**Where it lives:** george `tests/eval/`、`src/eval/`、CI、`docs/eval/`（无 migration，文件化 scoreboard）。**Effort:** 离线 harness ≈ **3–4 周，real**。

### 4.4 Per-user model — **做，但 high-stakes floor 要架构级处理，cost 控制比原设计更早可用**

- **`[critic]` high-stakes floor 的关键词 clamp 结构脆弱，要 clamp 两条路径。** `prompts/orchestrator.md` 既把 immigration 作为 **refusal-category 由 orchestrator 直答**，又把 immigration-as-knowledge（哪个 program/service）**delegate 给 know-things**。而 model 必须在 SDK 决定路由**之前**解析，关键词在 `resolveModels()` 时分不清这一 turn 最终走哪条。**正确做法：high-stakes 关键词命中时把 orchestrator 和所有 sub-agent 一起 clamp 到 ≥SMART**（便宜，两路全保），并承认关键词 recall 不完美 —— 配 Phase 2 的 post-hoc `refusal_domain` 审计，而不是把 clamp 当保证。
- **`[critic]` cost 控制不是只能 v2。** SDK 暴露 `maxBudgetUsd`（per-query、**server-enforced、无需持久内存、免疫 Container recycle**，超限返回 `subtype:'error_max_budget_usd'`）。这是 **per-turn 成本天花板，现在就能用** —— 可在 Phase 3（甚至 Phase 0 给 high-stakes turn 兜底）注入 `query()`。需要持久状态的只是 **per-user 日累计/总额 cap**，那个才是 v2。把两者分开说。
- **`user_model_config` 存 policy 输入**（cost_tier / ab_cohort / language_pref / explicit_override JSONB），不存裸 model 串，让换 model ID 无需 migrate 数据。
- **`src/agent/model-router.ts`** 是唯一选模型的纯函数：defaults → cost_tier → language → cohort → override → **floor clamp**，返回 `decision_trace`。
- **A/B 用确定性 hash**（`sha256(user_id+salt)%100`），稳定不每轮翻转。
- **不要在 telemetry + 真实质量 rubric 证明 parity 前，把 zh-economy 用户默认丢给 DeepSeek** —— "voice is the product"，这是 fairness flag。

**Where it lives:** `user_model_config` migration 在 bia-admin；`model-router.ts` + agents.config factory 重构 + orchestrator threading 在 george。**Effort:** 真实**多周、两 repo、branch-protected**。

### 4.5 Phasing/MVP — **采纳其 wedge 与排序作为全文骨架**（realism 最高）

采纳 Phase 0/1/2/3 排序（见 §7）并吸收修正：`turn_telemetry` 键 `user_id text`、无 FK、**不能 verbatim copy 013**（013 是 uuid FK）；`model_used` 标 "primary/last model" + mixed-model caveat；95% 覆盖率分母跨 6 个 entry point 明确定义（含绕过 orchestrator 的 handshake/user-command/injection 路径）；**staging 是 Phase 0 硬前提**；**`[critic]` GC 用 DB-side（bia-admin `pg_cron` 或 Supabase scheduled function），不要 in-process node-cron**（heartbeat_log 已证明这个 pattern 在本 codebase 静默失败），否则承载 `refusal_domain` 行为画像的表会留存超期、变合规风险。

### 4.6 隐私/治理 — 见 §5，有否决权，gate 全部上述。

---

## 5. 隐私与治理红线（non-negotiable，gate 一切）

1. **`turn_telemetry` "无正文" ≠ "无 PII"。** `user_id` 是手机号/email/openId，直接标识符。聚合端点必须 `GROUP BY`、**绝不 SELECT `user_id` 到 dashboard**；live feed 的 handle 在 **API 层** hash/截断。整表按 PII-bearing 对待。
2. **`/delete me` 必须级联到 `turn_telemetry`，在同一个 PR 里。** 否则用户自删后行为 telemetry 留存 ≤90 天 —— 本功能直接引入的合规倒退。
3. **复用现有 `admin_audit_log`，不新建冲突表。** 它支撑现有 `/delete me` 审计。
4. **high-stakes 推断本身是敏感 PII。** 一旦记 `refusal_domain`(immigration/mental_health/financial) keyed by handle，这张表就成了"谁问了签证/心理危机"的行为画像。RLS service_role-only、retention cron 从 day 1 就有、任何 per-domain breakdown 上 dashboard 前设**最小 cohort size 下限**（防 3am 问签证的单个学生被 re-identify）。
5. **per-admin 审计从 Phase 3 提前到 Phase 2。** 一旦按 user 记 refusal_domain/voicelint，泄露 token 就暴露行为画像。**`[critic]` 但"复用 admin_audit_log"不等于解决问责** —— 现存写入全是 `actor_email='system@george'`，真实 per-admin attribution 仍 block 在 auth stack（无 `SUPABASE_JWT_SECRET`）。所以 dashboard 的 authenticated-admin identity 是审计有意义的**硬前置**，在它之前改 `user_model_config` 只能记成 `system@george`、不可问责。
6. **本地 dev 直连 prod PII + 无 staging = Phase 0 blocker。** 所有 telemetry 写入 `TELEMETRY_ENABLED` gate + 本地 no-op writer。"验证 rows 落库再翻 flag" 只能在 **cloud canary**。**站起 staging Supabase 是 Phase 0 硬前提，不是 open question。**
7. **真实对话 export 给 model research 需要：** `research_consent` 表 + bia-roommate opt-in UI + NER 级 redactor + founder 对 judge-API egress 签字。四样齐之前，export 只能用 synthetic / allowlisted id。
8. **service-role key 只在 `src/db/*`**，telemetry writer 遵守，永不经 HTTP 暴露。

---

## 6. 关于"接入模型做神经领域研究 / 重新评估 / 每人不同模型"的诚实判断

**真实、weeks-scale 可达：**
- **Telemetry 账本** + per-turn token/cost/latency/model/outcome —— SDK 已把数据递过来，纯收割，最高杠杆。
- **离线 eval harness：** golden set + deterministic scorer(voiceLint + 常量 anti-fabrication + routing) + LLM-as-judge(对 AGENT.md persona，固定非被测模型，用 founder few-shots 校准) + `npm run eval` scoreboard + CI 回归 gate。
- **Model bake-off / 重评估：** 同一周真实流量（或 golden set）跑两个模型，对比 latency + cost(精确) + voiceLint 合规(弱代理)。这就是"重新评估"的真实形态。

**1–2 个月、gated 可达：**
- **per-cohort 重评估：** 按 platform/major/onboarding-stage/domain 切 telemetry，报告每 cohort 哪个模型赢。
- **每人不同模型：** `user_model_config` + agents.config factory + orchestrator threading。**但必须 gated** —— 只有当某 cohort 的 bake-off 显示可度量 delta（真实质量 rubric，不是 voiceLint 正则）时才上线。在数据证明前做 per-user 路由是 blind optimization。

**是 hype / research program，不是 weeks-scale：**
- **"神经领域研究" / fine-tuning / 训练 pipeline：** 这产品没有训练基础设施、没有 labeled outcome data、没有 weights 工作流。诚实改名为 **model bake-off + per-cohort re-evaluation**。
- **任何需要 engagement-outcome 的事**（学生是否真去了推荐 event、是否选了推荐课、是否留存）：这个信号**全系统不存在** —— `proactive_log` 只记 `sent`，不记 attendance。这是离线 eval（几周）和真正研究项目（没有）之间的分界线。
- **"voice 质量谁更好"用正则判** 几乎无意义 —— 模型可 voiceLint 全清却实质错误。真正质量轴需要那套缺失的 gold-standard 评测集 + LLM-judge。

**一句话：** "每人不同模型"是真目标，但它是**最后一步**，因为它需要 (a) telemetry 决定该给谁什么模型，(b) 质量 baseline 证明分配有效。先做后两者。

---

## 7. 分阶段路线图

每个 phase 的铁律：**bia-admin migration 先合并并应用 → george writer behind flag(default off) → cloud canary 验证 rows 落库 → 翻 flag → bia-admin UI**。半落地退化为 no-op。

### Phase 0 — Telemetry 地基（the wedge）
**做：** bia-admin migration 建 `turn_telemetry`(`user_id text`、**无 FK**、write-time `student_id` stamp、RLS service_role-only、索引 `(created_at DESC)`/`(user_id,created_at)`/`(model_used,created_at)`、**DB-side pg_cron 90 天 retention**) + `turn_telemetry_daily`。george：`src/db/telemetry.ts` `recordTurn`(fire-and-forget、silent-fail、`TELEMETRY_ENABLED` gate)；`runOrchestrator` 内部读 `total_cost_usd`/`modelUsage`(存 JSONB)/`is_error`/`subtype` + `Date.now()` bracket，**成功与错误分支都写、abort/supersede 也从 handler 写一行**；6 个 entry point + 绕过路径打 `sub_agent='system'` 行。**同 PR 把 `turn_telemetry` 加进 `/delete me` 级联。**
**`[critic]` 跨渠道成本非均匀，Phase 0 要画 channel×has-SDK-result 矩阵：** in-process orchestrator turn = 全成本；legacy **bridge-mode 转发到远端 /chat、成本在远端进程**（在远端记，别在 bridge 记，防双计/零计）；handshake/user-command/injection = 零 LLM 成本、`cost_usd=0`。
**`[critic]` 与 Spectrum 迁移协调：** CLAUDE.md 的 Task 14 会在 burn-in 后删 legacy iMessage 适配器 —— Phase 0 别把功夫花在马上要删的 `imessage.ts` 上。要么落在 cutover 后的 channel 集（spectrum+web+wechat）跳过 legacy，要么显式接受 legacy instrumentation 是 throwaway；`channel` 用能跨 legacy→spectrum 改名存活的 enum。
**显式 DEFER：** quality enrichment、auth 改造、per-user 路由。
**前提：** staging Supabase 站起；一下午 SDK spike 确认 message stream 形态。
**Success metric：** flag-on 后 1 周内，≥95%（分母 = runOrchestrator turns，明确排除绕过路径）的生产 turn 产生一行带非空 `model_used`/`tokens`/`cost_usd`/`latency_ms` 的 row；**含 error/abort turn**；`/chat` p95 latency 零增加；零对话崩溃归因于 writer。

### Phase 1 — Read API + v0 只读 dashboard
**做：** george `/admin/analytics/{usage,models,surfaces}` 聚合端点（读 `turn_telemetry_daily` + `heartbeat_log` + `proactive_log`，**三源各自成 panel、不 JOIN，或用 write-time student_id 等值连接**，零 PII，60s cache，复用现有 `adminAuth`）；cost 标 "directional trend, not billing-reconcilable"。bia-admin `/george/dashboard` 只读页（server-side 持 token，daily token/cost/latency 时序 + per-model 表 + surface split）。
**显式 DEFER：** per-admin RBAC、drilldown、quality panel、写操作。
**Success metric：** officer 不碰 SQL 就能答"近 7 天按模型的 tokens+cost+p95 latency"；dashboard 数字与手查误差 <5%；无 PII 暴露。

### Phase 2 — 质量 + research baseline + per-admin 审计
**做：** ALTER `turn_telemetry` 加 `voicelint_flags text[]`、`refusal_domain text`、`prompt_version text`(git SHA)。在 `runOrchestrator` 对**未经 markdown-strip 的原始模型输出**跑 voiceLint(advisory-only)；`戳到知识盲区` 等 boundary 短语 → `turn_outcome='knowledge_boundary'`；code-switch 用 Han/ASCII 比。**per-admin 身份**（确认 bia-admin auth stack 后设计，写真实 `actor_email` 进 `admin_audit_log`）。per-domain breakdown 上最小 cohort size 下限。离线 eval harness 在此并行成型（§4.3）。
**前提：** SDK spike 结论决定 anti-fabrication/routing 能做多深。
**Success metric：** 能对同一周真实流量产出 per-model 比较（voice-violation rate + refusal rate + cost + p95）—— model re-evaluation 决策的真实输入。

### Phase 3 — 每人不同模型（deferred goal，now buildable）
**做：** bia-admin migration 建 `user_model_config`(policy 输入)。george：`src/agent/model-router.ts`(纯函数 + high-stakes floor clamp **orchestrator 和 sub-agent 都到 ≥SMART** + 可选 `maxBudgetUsd` 兜底)；`agents.config` 重构为 per-invocation factory；`query({ model, maxBudgetUsd })`；heartbeat/squad-draft/lightweight 三个非 SDK 路径 adopt router。bia-admin model-assignment UI behind RBAC，每次改写 `admin_audit_log`。A/B 用确定性 hash + `variant_id`，由 Phase 2 telemetry 度量。`MODEL_ROUTING_ENABLED=false` 默认 = 今天行为，先放一小撮 test 用户。
**显式 DEFER：** per-user **日累计** cost cap（需持久状态，v2；但 per-turn `maxBudgetUsd` 现在就上）；zh-economy→DeepSeek 默认（等 parity 数据）；auto-rollback（先 manual rollback on alert）。
**Success metric：** 一个定义好的 cohort 能运行时（免 redeploy）分到非默认模型；每次分配可在 `admin_audit_log` 归因到某 admin；某 A/B variant 的 cost/quality delta 可从 dashboard 读出。**Gate：** 只在 Phase 0–2 全落地、且 cohort bake-off 显示可度量 delta 后才推进。

---

## 8. 最大的几个风险 + 现在就该做的第一步

**Top risks:**
1. **Scope creep —— 先做"每人不同模型/神经研究"headline，跳过 telemetry。** 最大政治风险。守住排序：Phase 3 显式 gated on Phase 0–2。
2. **跨 repo 半落地静默丢数据。** writer 在 migration 应用前上线 = insert 进不存在的表、只有一行 `console.error`，telemetry 全丢 —— 正是 `20260611` 记录的 messages 失败模式。靠严格排序 + flag-default-off + cloud canary 防住。
3. **PII / 合规倒退（三处具体）：** `turn_telemetry` 不进 `/delete me` 级联；handle 在聚合层泄露；refusal_domain 让表成行为画像。三处都必须在引入功能的同一 PR 里堵上。
4. **架构错觉（stress-test + critic 揪出）：** (a) high-stakes floor 要 clamp **orchestrator 和 sub-agent 两路**，因为 immigration 两种路由都存在且 model 在路由前解析；(b) per-agent 精确成本拿不到，但 **per-tier 近似成本（modelUsage by model）Phase 0 就能存**，别承诺 per-agent 精确面板、也别整张 DEFER；(c) **cost breaker 并非不可能**，`maxBudgetUsd` 现在就有、server-enforced。
5. **本地 dev 直连 prod PII + 无 staging。** staging 是 Phase 0 硬前提。

**现在就该做的第一步（本周，顺序）：**
1. **一下午的 SDK spike**（零依赖、零 migration）：临时 log 一个 know-things turn 的**原始 SDK message stream**，确认五件事 —— `m.usage` 是否给 `input/output_tokens`；`total_cost_usd`+`modelUsage` 是否如 v0.3.168 类型所述；**error/abort 分支是否仍带 cost/usage**；sub-agent 的 `tool_result` payload + name marker 是否可见；`query({ model })` 是否真换 orchestrator 模型。**这五个答案 gate 了 Phase 0/2/3 的全部 effort 估算。**
2. **并行推两件不阻塞的事：** (a) 找到 bia-admin migration+UI 的 named owner、确认其 review 延迟与真实 auth stack；(b) 站起 staging Supabase。
3. **写 Phase 0 的 bia-admin migration PR**（`turn_telemetry`+`turn_telemetry_daily`，`user_id text` 无 FK、write-time student_id、RLS service_role-only、DB-side pg_cron retention、**显式标注相对 013 uuid-FK 血缘是有意 deviation**）。george 侧 `recordTurn`+orchestrator instrumentation behind `TELEMETRY_ENABLED=false` 可并行合并、只在翻 flag 后写。

**核心判断：** "fix the dropped usage" 是真实、高杠杆、低风险的赢面，应作为 Phase 0 通过 `runOrchestrator` 内单个 `recordTurn` 发布。dashboard 的 auth、per-user 的 floor、eval 的数据飞轮 —— effort 和 PII 风险都被原始设计低估，必须按上面的修正版执行。

---

### 附：completeness critic 校正过的事实点（已合入正文）
- `maxBudgetUsd`(sdk.d.ts:1612) server-enforced per-turn cap → cost breaker 非"不可能"。
- `modelUsage: Record<string, ModelUsage>`(sdk.d.ts:1228) by-model → per-tier 成本 Phase 0 可存。
- `SDKResultError` 无 result string / Spectrum abort 无 result message → recordTurn 必须覆盖 error/abort。
- telemetry(user_id) vs proactive/heartbeat(student_id) → write-time stamp 或不 JOIN。
- `admin_audit_log` 现存写入全 `system@george` → per-admin 问责仍 block 在 auth stack。
- Spectrum Task 14 删 legacy iMessage → Phase 0 instrumentation 要协调。
- legacy bridge-mode 成本在远端 → channel×has-SDK-result 矩阵防双计。
- heartbeat_log 90 天 GC 是空头 COMMENT → retention 用 DB-side，不用 in-process node-cron。
