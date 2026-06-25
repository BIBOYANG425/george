# Plan：George Admin Dashboard 扩展（安全 · 质量 · 记忆/同意 · 增长 · 审计）

**日期：** 2026-06-24 ｜ **eng-review + Codex outside-voice：** 2026-06-25
**来源：** dashboard-additions brainstorm（6 视角）。
**状态：** REVIEWED — 过了 `/plan-eng-review`（8 个 section 发现 + Codex 10 条遗漏，全部裁决，见 §11 GSTACK REVIEW REPORT）。Codex 的重排被采纳（T1-A）：**read-only 先行，破坏性删除最后做。**
**一句话目标：** 把后台从「运营脉搏看板」升级成「安全 + 质量 + 记忆/同意可观测 + 审计」面板，**复用现有 read-only analytics + 文件控制 + 既有 `admin_audit_log` 表**，按 blast-radius 从小到大分 PR：先只读、再标记、再（带运营 SOP 的）安全、最后才碰破坏性删除。

---

## 0. 设计原则

1. **复用 > 重建。** 扩 `analytics.ts`(读) / 新 `actions.ts`(写) / `dashboard-html.ts`(面板) / 既有 `admin_audit_log` 表 / 既有 `user_observations` 情绪信号。不另起炉灶、不新建第二张审计表。
2. **read-only 先行，破坏性写最后。** 先把「能看」的稳上线；删记忆放最后一个 PR，且必须带全套护栏（§2 PR-N）。
3. **PII 安全沿用。** 列表/流走 `maskHandle`(`analytics.ts:473`)，drill-down 才解析全 handle；新面板同规矩。
4. **数据已存在优先；缺数据就降级而非假装。** onboarding 只做现有表支持的计数（无 `completed_at`，不画假漏斗，T2-B）。
5. **缺表/缺列优雅降级。** 新读函数 try/catch → 空 + 提示，绝不硬列名打挂整页（4A，照搬 `getMemoryConsent` 的 `select('*')` fail-closed）。
6. **写即敏感 + 可审计 + 不留脏缓存。** 所有写走 `actions.ts`，每个写调 `logAdminAction()`→`admin_audit_log`；任何动 `user_profiles` 的写必须**清 KV profile 缓存**（否则 George 5 分钟内还用旧记忆）。

---

## 1. What already exists（现状 + 复用核对，grounded 2026-06-25）

| 已有的东西 | 位置 | plan 怎么用 |
|---|---|---|
| 4 tab（概览/实时/用户/系统）+ setTab/refresh/drawer，**全是一个 HTML 字符串里的全局函数** | `dashboard-html.ts:159-225,362` | **复用但已到复杂度上限**（Codex#10）→ 新面板合并成**一个只读「Review」页**，别再加 3 个 tab + 删除按钮 |
| `getSystemHealth` 已读 `user_heartbeat_config` 的 consent 字段 | `analytics.ts:426-428` | 加 `consent_memory`，但**用 `select('*')` 不用硬列名**（否则未迁移即 500，Codex#3 / 4A）|
| `getUserDetail` 已渲染 `user_profiles` 6 blocks + 已做 handle→uuid **读** fallback | `analytics.ts:337,353-357` | 复用；加 `user_observations`；**写也必须走同一 uuid 解析**（1A）|
| **`admin_audit_log` 表已存在**（`actor_email/action/entity_type/entity_id/payload`），user-command 已在写 | `src/agent/user-command-router.ts:88` | **复用它，不新建 `admin_audit`**（Codex#1）。注意它 insert 时 swallow「表可能不存在」→ 确认 prod 有这张表 |
| `user_observations`（kind 含 emotion，salience 分）由记忆功能写 | 记忆功能 | **危机雷达主信号**（2A），不重建关键词扫描 |
| KV profile 缓存（300s TTL，`saveBlock`/`appendToBlock` 会 `cache.delete`）| `memory/profile.ts:81-125` | 删记忆必须经 `ProfileStore` 或显式 `cache.delete`，否则留脏缓存（Codex#5）|
| `checkInjection()` 纯 regex helper；调用点在 HTTP/iMessage **边界** | `src/security/injection-filter.ts:61`，`index.ts:419`，`adapters/imessage.ts:254` | **在边界记录** `source/sender/reason/text_preview`，**别污染 filter helper**；blocked 时常无 `messages.id`（Codex#7）|
| 唯一的写：`setHeartbeatPaused` + `setUserControls`（文件 `data/user-controls.json`，需 `/app/data` 卷）| `analytics.ts:450`，`user-controls.ts` | 逐步挪进新 `actions.ts`（3A），统一接 `logAdminAction` |
| handle→key 两种解析：profile uuid（`resolveProfileUserId`）+ heartbeat 候选循环 `[handle,user_id,id]` | `analytics.ts:361,455` | 抽成共享 `resolveProfileKey` + `resolveHeartbeatKey`（6A）|
| `pending_users`：只有 `status`(pending/completed/abandoned)+`created_at`+`reminded_at`，**无 `completed_at`**；completion 由 bia-roommate 改 status | `015_pending_users.sql`，`src/onboarding/pending-users.ts:47` | 只做计数 + 积压时长，**不画带时间的漏斗**（T2-B）|

---

## 2. PR 序列（blast-radius 从小到大；Codex 重排 T1-A）

### PR-0 · 审计地基（先于任何破坏性写）
- 统一 **既有 `admin_audit_log`**：`logAdminAction({actor, action, entity_type, entity_id, payload})` 助手，**actor = Cf-Access-Authenticated-User-Email header**（取不到 fallback `admin-token`，5A）。
- 把现有 `setHeartbeatPaused` / `setUserControls` 接上 `logAdminAction`（回填）。
- 确认 prod 有 `admin_audit_log` 表（user-command 路径 swallow 了「表不存在」，可能从没建）。`S-M`

### PR-1 · 记忆/同意**只读**可观测（无删除）
- 概览/Review：`consent_memory` opt-in 数 + 占比（`getSystemHealth` 加，`select('*')`）。
- drawer：`user_profiles` 6 blocks（已有）+ `user_observations`（salience DESC，2A 复用）。**只看**。
- 解析正确：展示按真实 profile key（handle→uuid，6A 的 `resolveProfileKey`）。`M`

### PR-2 · AI 质量：坏回合标记 + 编造哨兵
- 实时流/对话每条 George 回复加「👎 标记」→ `actions.ts:flagMessage` 写 `message_flags`。
- **`message_flags` schema 带运行上下文快照**（model/agent/tool_calls/prompt 版本/相邻上下文），否则「导出修 prompt」拿不到当时条件（Codex#6）。
- 编造哨兵（read）：assistant 回复含数字/¥/教授名 **且** `tool_calls.tools` 空 → 疑似。Review 页一个面板。`M`

### PR-3 · 安全：危机雷达（**先写运营 SOP 再上**）
- `getDistressQueue`（read）：主信号 = `user_observations`（emotion/state，salience≥阈值，2A）+ 关键词补充。Review 页红色队列。
- **前置门（Codex#8）：** 上线前先定 SOP —— 谁看、多久看、误报怎么关、危机升级给谁、非工作时间怎么办。**push 告警视为「让雷达真正可用」的一部分**（不是 later），否则只是制造未处理风险。`M` + SOP

### PR-4 · 增长（降级版）
- onboarding：`pending/completed/abandoned` 计数 + 「pending 卡了多少天」积压名单（**不做带时间的转化漏斗**，T2-B）。
- 回头客/at-risk：`messages.created_at` 算活跃天数/沉默。`S-M`

### PR-N（最后）· 记忆**删除/纠正**（破坏性，全套护栏）
- `actions.ts:clearProfileBlock` / `deleteObservation`，**必须全部满足**：
  1. handle→uuid resolve（1A / `resolveProfileKey`）+ owner 校验
  2. 走 `ProfileStore`（或显式 `cache.delete`）**清 KV 缓存**（Codex#5）
  3. `logAdminAction` 写审计（PR-0 已就位）+ `payload` 存被删原值快照
  4. 前端二次确认（同「封禁」风格）`M`

### 快赢（穿插，S）：用户搜索/筛选（前端 filter）、模型配置总表（`listUserControls` 已有）、consent 占比卡、注入计数。
### 大想法（Phase 6，L）：George 自评周报（依赖 PR-2 的 flagged 数据）。

---

## 3. 裁决表（eng-review + cross-model）

| # | 决定 | 落地 |
|---|---|---|
| 1A | 写端点 handle→uuid resolve + 抽 `resolveProfileKey` 读写共用 | `actions.ts` + 解析模块 |
| 2A | 危机雷达主信号复用 `user_observations`，关键词补充 | PR-3 |
| 3A | 新建 `src/admin/actions.ts` 集中所有写，审计钩子集中 | PR-0/PR-2/PR-N |
| 4A | 新表/新列读函数 try/catch 降级，不硬列名 500 | 全 PR |
| 5A | 审计 actor 取 Cf-Access 邮箱，fallback admin-token | PR-0 |
| 6A | 两种 handle 解析都抽成共享（profile + heartbeat） | 解析模块 |
| 7A | 危机雷达 curated 边界案例单测（真危机触发 + 误报口语不触发） | PR-3 tests |
| 8B | 重型聚合面板不上 15s 自动刷新，切 tab + 手动才加载 | `dashboard-html.ts` |
| T1-A | read-only 先行；破坏性删除放 PR-N + 全套护栏；顶上加 PR-0 | 整体序列 |
| T2-B | onboarding 降级为计数 + 积压，不动表不跨仓 | PR-4 |
| Codex#1 | 复用 `admin_audit_log`，**不新建 `admin_audit`** | PR-0 |
| Codex#6 | `message_flags` 带运行上下文快照 | PR-2 |
| Codex#7 | injection 在边界埋点（source/sender/reason/preview），不污染 helper | PR-3 |
| Codex#10 | 新面板合并成一个只读「Review」页，别再加 3 tab | 前端 |

---

## 4. 改动文件清单

| 文件 | 改动 | PR |
|---|---|---|
| `src/admin/resolve.ts`（新）| `resolveProfileKey` + `resolveHeartbeatKey`（6A），读写/heartbeat 全走它 | PR-0/1 |
| `src/admin/actions.ts`（新）| 所有写：`logAdminAction`、`flagMessage`、`clearProfileBlock`、`deleteObservation`，迁入 `setHeartbeatPaused`/`setUserControls`（3A）| PR-0/2/N |
| `src/admin/analytics.ts` | 加 consent_memory(`select('*')`)、observations、`getDistressQueue`、`getFabricationSuspects`、`getOnboarding*`、`getRetention`、`getAuditLog`（全 try/catch 降级，4A）| 各 PR |
| `src/admin/router.ts` | 挂新端点，全走 `auth`+`wrap` | 各 PR |
| `src/admin/dashboard-html.ts` | 一个只读「Review」页（合并 flags/distress/fabrication）+ drawer 加 observations + 用户搜索；重型面板不上自动刷新（8B）| 各 PR |
| `supabase/migrations/` | `message_flags`（带上下文快照列）；**确认 `admin_audit_log` 在 prod**（不新建 audit 表）| PR-2/0 |
| injection 边界（`index.ts`/`adapters/*`）| blocked 时记 `source/sender/reason/preview`（Codex#7）| PR-3 |
| `tests/admin/*` | §6 覆盖 | 各 PR |

---

## 5. 失败模式（每个新 codepath 一个真实生产故障）

| Codepath | 故障 | 有测? | 有错误处理? | 用户/运营看到? |
|---|---|---|---|---|
| `clearProfileBlock` 拿 handle 直写 uuid 列 | 静默 no-op（以为删了没删）或 invalid-uuid | ✅ 1A 回归测试 | ✅ resolve 后写 | **静默→必须测**（已列 CRITICAL）|
| 删 block 不清 KV | George 5min 内继续用旧记忆 | ✅ PR-N 测 cache.delete 被调 | ✅ 走 ProfileStore | 静默（最危险，Codex#5）|
| 新读函数撞未迁移表 | 整 Review 页 500 | ✅ 4A 缺表降级测 | ✅ try/catch→空 | 面板显示「该表未迁移」|
| 危机雷达误报泛滥 | cry-wolf，红队列没人看 | ✅ 7A 误报口语不触发 | n/a | 运营 SOP（PR-3 前置门）|
| `logAdminAction` 漏接某写端点 | 该操作无留痕 | ✅ 每个写端点一条审计测 | n/a | 审计有洞=假安全 |
| injection 边界无 messages.id | 复用 message_flags.message_id 崩 | ✅ 边界埋点测 | ✅ 边界独立记录 | — |

> **critical gap（无测+无错误处理+静默）：0** —— 上面每条都已配测 + 处理。

---

## 6. 测试覆盖（vitest，`tests/admin/*` 从零起）

```
[+] resolve.ts        resolveProfileKey/resolveHeartbeatKey 候选 fallback           [CRITICAL]
[+] actions.ts        clearProfileBlock: handle→uuid 解析 + 清 KV + 写审计           [CRITICAL-REGRESSION 1A/Codex#5]
                      deleteObservation: 解析 + missing-oid no-op + 审计
                      flagMessage: 写 + 上下文快照 + 审计
                      logAdminAction: 每个写端点都落一条                            [CRITICAL]
[+] analytics.ts      consent_memory 计数 + 零同意；observations onboarded vs 访客
                      getDistressQueue: ★★★ 真危机触发 + 误报口语不触发(7A)
                      getFabricationSuspects: 数字+无tools→报 / 数字+有tools→不报
                      getOnboarding/getRetention: 计数 + 积压阈值 + 空态
                      新表读: 缺表→空不500 (4A)                                    [CRITICAL]
[+] PII               maskHandle 在所有新 list/feed 不泄全 handle                    [regression]
无 prompt/LLM 改动 → 不需 EVAL 套件（检测器是纯函数）。
```

---

## 7. 性能

- 重型聚合（fabrication/retention/onboarding）各 `.limit(10000)` 扫 messages → **不上 15s 自动刷新，切 tab + 手动才加载**（8B）。
- `getAuditLog` append-only → `ORDER BY created_at DESC LIMIT N` 防无界。
- 危机雷达主走 `user_observations`（salience 过滤，比全 message 扫轻）。

---

## 8. NOT in scope（明确不做 + 理由）

- **带时间的真 onboarding 漏斗**：需 `pending_users.completed_at` 列 + bia-roommate submit 写入，跨仓，留作后续（T2-B）。
- **PII 串号检测**（George 把 A 私信透给 B）：需语义判断，复杂。
- **延迟 p50/p95**：`messages` 需加 latency 列 + reactive 写入。
- **push 告警的跨系统集成**：PR-3 把它当「让雷达可用」的一部分纳入，但具体 Slack/Server酱 接线独立排期。
- **真实 per-admin 身份体系**：PR-0 先从 Cf-Access header 取邮箱当 actor；完整身份/登出/轮换体系后续。
- **大数据量 SQL 化**：现 `.limit(10000)` 内存聚合，量级上去再转 SQL 视图。

---

## 9. 并行化

| 步骤 | 模块 | 依赖 |
|---|---|---|
| PR-0 审计地基 | `src/admin/`（resolve+actions+audit）| — |
| PR-1 只读记忆/同意 | `src/admin/`（analytics+dashboard-html）| PR-0（解析模块）|
| PR-2 质量标记 | `src/admin/` + migration | PR-0 |
| PR-3 安全 | `src/admin/` + injection 边界 | PR-0；SOP |
| PR-4 增长 | `src/admin/` | PR-0 |
| PR-N 删除 | `src/admin/actions` + ProfileStore | PR-0,1 + SOP |

**几乎全部触 `src/admin/`** → Lane 单一、顺序实现（PR-0 先，其余串行）；唯一可分叉的是 PR-3 的 injection 边界埋点（`index.ts`/`adapters/`，独立模块，可与 admin 并行）。其余：**Sequential implementation**。

---

## 10. Implementation Tasks
Synthesized from this review. P1 blocks ship; P2 same-branch; P3 follow-up.

- [ ] **T1 (P1, human ~30min / CC ~5min)** — actions/resolve — 写端点 handle→uuid resolve + `resolveProfileKey` 助手（读写共用）
  - Surfaced by: Architecture 1A + Codex#2 + 学习 PROFILE_KEY_HANDLE_VS_UUID — Files: src/admin/resolve.ts, actions.ts — Verify: 单测 handle 解析到 uuid 再写
- [ ] **T2 (P1, human ~30min / CC ~5min)** — actions — 删 block 走 ProfileStore/显式清 KV 缓存
  - Surfaced by: Codex#5（KV 脏缓存）— Files: actions.ts, memory/profile.ts — Verify: 删后 cache.delete 被调，再读不命中旧值
- [ ] **T3 (P1, human ~1h / CC ~10min)** — audit — 复用 `admin_audit_log` + `logAdminAction` 接每个写端点 + Cf-Access actor
  - Surfaced by: Codex#1/#4 + 5A — Files: actions.ts, router.ts — Verify: 每个写端点一条审计行；actor=邮箱
- [ ] **T4 (P1, human ~1h / CC ~15min)** — analytics — 危机雷达走 observations + curated 误报单测
  - Surfaced by: 2A + 7A + Codex#8 — Files: analytics.ts, tests — Verify: 真危机触发、"被课搞死了"不触发
- [ ] **T5 (P2, human ~1h / CC ~10min)** — actions — 拆 `actions.ts`，analytics.ts 恢复纯读
  - Surfaced by: 3A — Files: src/admin/* — Verify: analytics.ts 无写
- [ ] **T6 (P2, human ~20min / CC ~5min)** — analytics — 新表读 try/catch 降级
  - Surfaced by: 4A + Codex#3 — Files: analytics.ts — Verify: 缺表→空不 500
- [ ] **T7 (P2, human ~30min / CC ~10min)** — dashboard — 重型面板移出 15s 自动刷新
  - Surfaced by: Perf 8B — Files: dashboard-html.ts — Verify: 切 tab/手动才 fetch
- [ ] **T8 (P2, human ~30min / CC ~10min)** — dashboard — 新面板合并为只读「Review」页
  - Surfaced by: Codex#10 — Files: dashboard-html.ts — Verify: 不新增 3 tab
- [ ] **T9 (P2, human ~30min / CC ~5min)** — analytics — onboarding 降级为计数+积压
  - Surfaced by: T2-B + Codex#9 — Files: analytics.ts — Verify: 不依赖 completed_at
- [ ] **T10 (P3, human ~1h / CC ~15min)** — security — injection 边界埋点（source/sender/reason/preview）
  - Surfaced by: Codex#7 — Files: index.ts, adapters/* — Verify: blocked 在边界留痕，不动 filter helper

---

## 11. 设计（plan-design-review 2026-06-25）

内部 APP UI 控制台，沿用 `dashboard-html.ts` 既有暗色设计系统（CSS vars + `.panel/.bar/.pill/.badge/.msg/card()`）——**不引入新视觉语言**。设计完整度 4/10 → 8/10。

### Review 页层次（1A）
危机置顶、红色左边界区别 → 其下 👎 待复盘 flags → 再下 ⚠ 疑似编造（amber）。顶部 **Review tab 加危机计数徒章（仅 >0 时显示）**，不点进去也能扫到危机。Review 页保持克制列表，不做 card-mosaic（App-UI rule）。

### 交互状态表（每个新面板必须）
| 面板 | loading | empty | error |
|---|---|---|---|
| 🆘 危机队列 | 骨架行 | **安心型**「这会儿没人需要 check-in，一切安好」（2A，非冷「暂无」）| 沿用 `loadX` catch「加载失败：…」|
| 👎 待复盘 / ⚠ 编造 | 骨架行 | 「暂无」中性 | 同上 |
| consent 卡 / onboarding / 留存 | 骨架 | 「数据从新对话开始采集」 | 缺表→「该表未迁移」（4A） |
| 记忆 drawer（observations）| 骨架 | 「George 还没记住关于 TA 的事」 | 同上 |

### 删除确认 + a11y（3A，PR-N）
两步确认（克制风格，非裸 `confirm()`）+ 键盘可操作 + 焦点 trap + 危险用「图标 + 文字」不只靠红色 + 删前展示被删原值快照。

### Design 实现任务
- [ ] **D1 (P2)** dashboard — Review 页 distress-first 布局 + tab 危机计数徒章（1A）
- [ ] **D2 (P2)** dashboard — 每个新面板补 loading/empty/error；危机用安心型空态（2A）
- [ ] **D3 (P2)** dashboard — 新面板复用既有 CSS vars + 组件类，不引入新视觉语言（Pass 5）
- [ ] **D4 (P3, PR-N)** dashboard — 删除两步确认 + 焦点 trap + 危险不只靠色（3A）
- [ ] **D5 (P3)** dashboard — 验证 `--bad` 红在暗底对比度 ≥4.5:1（Pass 6）

### NOT in scope（design）
- 移动端响应式：桌面专用内部工具，低优先。
- brand variant mockups：设计语言已固定 + 无 OpenAI key，价值低。
- DESIGN.md：暂无，可后续 `/design-consultation`（内部工具优先级低）。

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 8 findings (5 arch / 1 cq / 1 test / 1 perf), all decided 1A·2A·3A·4A·5A·6A·7A·8B |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score 4/10 → 8/10, 3 decisions (Review 页层次+tab 徒章 / 安心型危机空态 / 删除确认+a11y) |
| Outside Voice | Codex (gpt-5.5) | Independent 2nd opinion | 1 | issues_found→absorbed | 10 missed items; 3 load-bearing claims verified against source; re-sequencing adopted |

- **CODEX:** caught 3 verified facts the plan got wrong — `admin_audit_log` already exists (reuse, don't add `admin_audit`), `pending_users` has no `completed_at` (no real funnel), KV profile cache needs invalidation on delete. Re-sequencing (read-only first, delete last) adopted.
- **CROSS-MODEL:** strong agreement on handle→uuid (1A=Codex#2), graceful-degrade (4A≈Codex#3), audit-actor (5A≈Codex#4). Tensions resolved by user: T1-A (read-only first, delete last) + T2-B (downgrade funnel). No remaining disagreement.
- **VERDICT:** ENG + DESIGN CLEARED — 8 eng findings + 10 Codex items + 3 design decisions folded into the re-sequenced plan (PR-0 audit → PR-1 read-only → PR-2/3/4 → PR-N delete-with-guards). Ready to implement PR-0.

NO UNRESOLVED DECISIONS
