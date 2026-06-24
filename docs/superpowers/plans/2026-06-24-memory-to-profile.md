# Plan：记忆及时落 profile — 开 capture 兜底 + reactive update_memory 工具

**日期：** 2026-06-24
**一句话目标：** 让"模型检测到值得记的事"**及时**落进用户的 profile block。两层（用户已拍"两个都要"）：**① capture 兜底**（每回合抽取器 → append 进 block，覆盖面，含 fast-path）+ **② reactive `update_memory` 工具**（full-agent 回合里模型自己判断"这事得记" → 显式写，精准、低噪）。
**设计来源：** 记忆调查 wf_w550yxdpc + 2026-06-24 对当前 main 重新核实（行号已对）。

---

## 0. 决定（已拍）
1. **两个都要**：capture（floor）+ update_memory 工具（precision）。它们互补——capture 覆盖每回合含 fast-path（fast-path 不能调工具），工具在 full-agent 回合精准抓关键事实。
2. 走老套路：plan → plan-eng-review → 实现 → ship。两层各自默认关 flag。

---

## 1. 当前现状（grounded，对 main 2026-06-24 核实）

| 事实 | 位置 |
|---|---|
| **同回合抽取→落 block 的机器已存在，但默认关** | `captureFactsFromTurn` `capture.ts:154`，`isCaptureEnabled()` 读 `MEMORY_CAPTURE_ENABLED==='true'`（`:32-33`，默认 false） |
| 抽取 = 一次 `callLightweightLLM`（jsonMode, 400tok），出 `{facts, observations}` | `extractMemoryFromTurn` `capture.ts:119` |
| 每个 fact → `store.appendToBlock(profileKey, block, fact)`（原子去重 RPC `append_to_profile_block`，cap 4000） | `capture.ts:184` → `profile.ts:130/188` |
| 可写 block = 6 块除 `george_notes` | `CAPTURE_BLOCKS` `capture.ts:42`（identity/academic/interests/relationships/state） |
| 四条入口全接、回复后 fire-and-forget（**零回复延迟**） | `index.ts:257`(/chat)、`:349`(SSE)、`:547`(Path B)、`spectrum.ts:447`(Spectrum) |
| **reactive 工具不存在**：`update_block` 只在 heartbeat（非 SDK 注册） | `src/tools/heartbeat/update-block.ts:30` |
| **reactive 记忆工具的现成范式 = `recall_memory`**：`GEORGE_RECALL_TOOL_ENABLED` 门，进 `ALL_TOOLS`（`tools/index.ts:113`）+ `ORCHESTRATOR_DIRECT_TOOLS`（`agents.config.ts:122-123`，经 `RECALL_TOOL_DIRECT`） | 照抄它 |

**三个缺口（调查挖出，本计划必须处理，不是裸翻 flag）：**
- **A. 失败被吞、无观测**：`capture.ts:203` 只 warn `memory_capture_failed`，成功才 log `memory_capture{written,observed}`。静默失败的写入对调用方不可见 → 加成功/失败计数指标。
- **B. 每回合成本**：capture 开后每回合跑 `resolveProfileUserId`（`students.ts:13`，**未 memoize**，最多 2 次 students 查询）+ 抽取 LLM。fire-and-forget 不压回复延迟，但是真 DB/LLM 负载 → memoize resolveProfileUserId + 节流。
- **C. PII / 同意**：capture 把**学生 PII** 写进 `user_profiles`，今天**只有全局 flag、没有 per-user 同意门**（heartbeat 有 `consent_proactive_messages`，记忆没有）→ §9 必须先定。

---

## 2. 设计（两层）

```
                  reactive turn (回复已发出)
                          │
   ┌──────────────────────┼─────────────────────────┐
   │ ① CAPTURE (floor)     │  ② update_memory 工具 (precision) │
   │ 默认关 MEMORY_CAPTURE  │  默认关 GEORGE_UPDATE_MEMORY_TOOL  │
   ├──────────────────────┤  ───────────────────────────────┤
   │ 每回合(含fast-path)    │  仅 full-agent 回合(fast-path 不能调工具) │
   │ fire&forget 回复后跑   │  模型在生成中内联调用              │
   │ 抽取器→所有durable facts│  模型自判"这事得记"→单条显式写      │
   │ 盲抽,覆盖广,有噪        │  高信号,低噪,无盲抽               │
   └──────────┬───────────┘  ────────────┬──────────────────┘
              ▼                            ▼
        resolveProfileUserId(handle→user_id)   [memoized]
              ▼                            ▼
        ProfileStore.appendToBlock(user_id, block∈CAPTURE_BLOCKS, fact)
        └─ append_to_profile_block RPC: 原子 + 按子串去重 + busts KV cache
           (两层都走它 → 同一事实重复写也不会双存)
              ▼
        下一回合 loadProfile 看到 (N+1 可见; 缓存在回复后失效)
```

### ① Capture 层（floor）
- 把 `MEMORY_CAPTURE_ENABLED` 打开（env），**但先补三个缺口（A/B/C）**，不是裸翻。
- **PII 同意门（Issue 2 + codex #1/#2，写读都 gate、fail-closed）**：`consent_memory`（仿 heartbeat `consent_proactive_messages`）**同时 gate 写入和读取/注入**——拒绝/未表态 → 既不新写、**也不把该用户现有 profile 注入 prompt**（真正"别记我"）。**fail-closed**：缺列/未表态 = 不记不用，现有用户经 onboarding 补同意后才启。这把 scope 扩到 **profile 加载注入路径**（`orchestrator.ts:768` 的 loadProfile/注入要先查 consent，不只 capture/工具写入处）。**跨仓依赖**：`consent_memory` migration 先在 bia-admin 落、onboarding 采集——**capture 上 prod 前置**。
- **source-grounding 反编造（codex #4，代码级）**：仿现有 fast-path 防编造门（`scanFabricationRisk`）。抽取器只写**能从 STUDENT 文本推出**的事实（不采信 GEORGE 的建议/猜测）；每条 fact 带一句来源引文，**代码校验该引文确在学生输入里**才落；`update_memory` 工具同理要 quote。与现有 anti-fabrication 架构一致，不靠 prompt 信仰。
- 成本/延迟：抽取器 fire-and-forget 在回复**之后**跑（四入口已如此），**零回复延迟**；加 memoize 后每回合多一次轻量 LLM。
- **两层全开的成本（eng-review 定，Issue 3）**：先两个都开（capture 兜底 + 工具精准），**不**按路径拆分；抽取是便宜的 lightweight LLM，靠缺口 A 新加的观测指标看真实成本，再决定要不要拆。flag 可调、可逆——不为未测量的成本提前加管道。
- 落地 = N+1 可见（RPC 写完 busts KV cache，下一回合 loadProfile 拿到）。这是契约，不是 bug。

### ② update_memory 工具（precision）
- **照抄 `recall_memory` 范式**：新 `src/tools/update-memory.ts`，`isUpdateMemoryToolEnabled()` 读 `GEORGE_UPDATE_MEMORY_TOOL_ENABLED`（默认 false）；`tools/index.ts` 条件加进 `ALL_TOOLS`；`agents.config.ts` 经 `UPDATE_MEMORY_DIRECT` 加进 `ORCHESTRATOR_DIRECT_TOOLS`（自然进 trunk 的 `TRUNK_TOOLS`）。injectable deps + `wrapTool` 兜底（永不抛）+ 非 onboarded handle → graceful no-op，全照 recall_memory。
- 入参 `{block, fact, user_id}`：`user_id`=handle，**经 `resolveProfileUserId` 解析成 uuid**（PROFILE_KEY_HANDLE_VS_UUID：直接拿 handle 写会写错 key/抛 invalid-uuid）；校验 `block ∈ CAPTURE_BLOCKS`、fact 非空、consent_memory 同意 → `ProfileStore.appendToBlock(uuid, block, fact)`。
- **handle 注入（eng-review 定，Issue 1）**：模型要能把 handle 作为 user_id 传进来，靠 orchestrator 的 handle-上下文块注入。**那个块的门要从「仅 RECALL flag」拓宽成「RECALL 或 UPDATE_MEMORY 任一开」**——否则只开 update_memory 时模型拿不到 handle → 工具静默 no-op、什么都不写。
- **block 白名单单一来源（DRY，codex 修正）**：在 **`profile.ts` 暴露 `DURABLE_FACT_BLOCKS`**（不是从 capture.ts 导出——那会把 extractor/LLM/observation 依赖拖进工具），capture / 工具 / reflect 共用。
- **handle 块要改写成通用文案（codex #8）**：`buildRecallToolContextBlock`（orchestrator.ts:169）是 recall 专用措辞；门拓宽后要改成通用「memory tools context」，否则只开 update_memory 时会注入 recall 文案但没 recall 工具。测试要断言措辞贴合开启的工具，不能只断言 handle 出现。
- prompt 引导（master 或工具 description）："学生透露关于自己的 durable 事实（专业/作息/兴趣/关系/状态）时，调 update_memory 记一条；闲聊/一次性的别记。" 受 master.md 的 anti-fabrication 约束——只记学生**说过的**，不臆造。
- 两层共用 appendToBlock 的子串去重 → full-agent 回合同时跑 capture + 工具也不会双存同一事实。

---

## 3. 改动文件清单

| 文件 | 改动 |
|---|---|
| `bia-admin`（跨仓，先做） | migration 加 `consent_memory` 列（仿 `consent_proactive_messages`）；onboarding 表采集它。**capture 上 prod 的前置** |
| `src/db/students.ts` | `resolveProfileUserId` 加短 TTL memoize（缺口 B；handle→user_id 几乎不变，安全缓存几分钟） |
| `src/memory/profile.ts` | 暴露 `DURABLE_FACT_BLOCKS`（block 白名单单一来源，codex #6） |
| `src/memory/capture.ts` | 缺口 A：成功/失败都发计数指标；**查 consent_memory 未同意不写**；**source-grounding 校验**（引文确在 STUDENT 文本里才落，codex #4）；复用 `DURABLE_FACT_BLOCKS` |
| `src/tools/update-memory.ts`（新） | `update_memory` 工具 + `isUpdateMemoryToolEnabled()`，照抄 `recall-memory.ts`；resolveProfileUserId + consent + source quote 校验 + 复用 `DURABLE_FACT_BLOCKS` |
| `src/tools/index.ts` | 条件注册 `update_memory`（镜像 `recall_memory` `:113`） |
| `src/agent/agents.config.ts` | `UPDATE_MEMORY_DIRECT` 加进 `ORCHESTRATOR_DIRECT_TOOLS`（镜像 `:122-123`） |
| `src/agent/orchestrator.ts` | handle 块门拓宽 + 改通用「memory tools」文案（Issue 1 + codex #8）；**profile 加载注入处加 consent_memory gate**（codex #1，`:768`） |
| `prompts/master.md` 或工具 description | update_memory 何时调的引导（过 voice-guard） |
| `.env.example` | `MEMORY_CAPTURE_ENABLED`、`GEORGE_UPDATE_MEMORY_TOOL_ENABLED` |
| `tests/*` | 见 §5 |

---

## 4. Flags（都默认关）
| flag | 默认 | 作用 |
|---|---|---|
| `MEMORY_CAPTURE_ENABLED` | false | 开 capture 兜底层 |
| `GEORGE_UPDATE_MEMORY_TOOL_ENABLED` | false | 开 reactive update_memory 工具 |
| `GEORGE_OBSERVE_ENABLED` | false（现状不动） | Observer 写 user_observations（独立路径，本期不碰） |

---

## 5. 测试（IRON：OFF 路径 byte 不变）
- **capture OFF 等价（IRON 回归，codex #3 修正）**：`captureFactsFromTurn` 早返回的门是 `MEMORY_CAPTURE_ENABLED` **且 `GEORGE_OBSERVE_ENABLED`** 都关（capture.ts:165）——不是 update_memory flag。测试要把**这两个**关掉断言零写入、byte 不变。consent 门的放置不能误伤 observe-only 路径。
- **capture ON**：注入假 extractor 出一个 fact → 断言 `appendToBlock(profileKey, block, fact)` 调用一次、block 在 CAPTURE_BLOCKS、`george_notes` 永不被写。
- **consent 门（Issue 2，capture + 工具各一条）**：`consent_memory` 未同意 → 即使 flag 开也**零写入**。
- **capture 失败可观测（缺口 A）**：extractor 抛 → 断言失败计数指标 +1（不再静默）。
- **resolveProfileUserId memoize**：同 handle 连调 N 次 → 底层 students 查询只跑一次（TTL 内）。
- **update_memory 工具 OFF**：flag 关 → 不在 `ALL_TOOLS`/`ORCHESTRATOR_DIRECT_TOOLS`（镜像现有 recall_memory 的 OFF 断言）。
- **update_memory 工具 ON**：flag 开 → 在工具集；`{block:'academic',fact:'...'}` → appendToBlock 命中；非法 block / 空 fact → 拒绝；**非 onboarded handle（resolve→null）→ graceful no-op、不抛**。
- **handle 注入（Issue 1）**：只开 update_memory flag（recall 关）→ 断言 orchestrator 仍把 handle 注入 prompt 上下文（否则工具静默 no-op）。
- **去重**：同一 fact 经 capture + 工具各写一次 → 断言 block 里只出现一次（RPC 子串去重）。

---

## 6. 灰度
- 两 flag 默认关 → 现状 byte 不变。
- 先开 `MEMORY_CAPTURE_ENABLED` 给单用户、看 `memory_capture` 指标（写入量/失败率）几天 → 再开 `update_memory` 工具 → 再放量。

---

## 7. NOT in scope
- **Observer→profile 提升（reflector 解耦出 12h heartbeat）**：调查里的第三条路径，本期不动（GEORGE_OBSERVE/REFLECT 维持现状）。
- **same-reply 可见**：要在回复**前**抽取，压回复延迟——否决，N+1 是对的取舍。
- **heartbeat 取模/记忆**：与本期无关。
- **block 压缩解耦**：append 超 4000 设 compaction_due、由 heartbeat 压；heartbeat 默认开，够用。不改。

---

## 8. 风险
- **PII 写入**（缺口 C）：见 §9，是落地前的硬门。
- **成本**：capture 开 = 每回合一次抽取 LLM + （memoize 后）偶尔一次 students 查询；full-agent 回合若工具也开，可能再加一次工具往返。fire-and-forget 不压回复，但是真 token/DB 负载，放量看指标。
- **抽取器误抓/噪声**：盲抽可能记进无聊事实；工具层精准但召回低——两层互补正是为此。master.md anti-fabrication 约束工具层不臆造。
- **N+1 可见**：本回合捕获的事实下一回合才进 prompt（缓存回复后失效）。可接受。
- **语义重复（codex #5）**：appendToBlock 去重是**字面子串**——"CS sophomore" vs "sophomore CS major" 会双存。capture + 工具不同措辞写同一事实时累积；靠 heartbeat compaction 语义收敛，本期不额外做。记成已知风险。
- **block 膨胀（codex #7）**：capture 开后 append 量上升 → 更快触 4000 上限；溢出只由 heartbeat compaction 收。若 heartbeat 关/无 config/compaction LLM 失败 → block 长期膨胀且继续注入 prompt。flip 前确认 heartbeat 在跑；可后续加硬上限保护。

---

## 9. 决定（plan-eng-review 已定）
1. **PII 同意门** → **加 per-user `consent_memory`**（仿 heartbeat consent）。capture + 工具落 profile 前都查它。跨仓：bia-admin 先加 migration、onboarding 采集——capture 上 prod 前置。（Issue 2）
2. **capture 噪声** → 先全记、靠 heartbeat compaction 收，**不**额外加 salience 门槛（先简单，观测说话）。
3. **工具 vs 抽取取舍** → **两个都开、不按路径拆**；抽取便宜，靠新观测指标看真实成本再决定拆不拆。（Issue 3）
4. **handle 注入**（Issue 1）→ 拓宽 orchestrator handle-上下文块的门为「RECALL 或 UPDATE_MEMORY 任一」。
5. **CAPTURE_BLOCKS 单一来源**（DRY）→ 从 capture.ts 导出、工具复用。

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 arch issues + 1 DRY, resolved |
| Outside Voice | `codex` | Independent 2nd opinion | 1 | issues_found → resolved | 8 findings: 3 corrections folded, 2 substantive decided, 3 noted as risks |

- **GROUNDING:** capture/profile/recall_memory/consent 都对 main 2026-06-24 核实；`update_memory` 照抄的 `recall_memory` 已读实。
- **决定（共 7）：** ① consent_memory **写+读都 gate、fail-closed**(扩到 profile 注入路径；跨仓 bia-admin 前置)；② 噪声先全记靠 compaction；③ 两层都开、看观测再拆；④ handle 块门拓宽 + 改通用文案；⑤ block 白名单从 **profile.ts 暴露 `DURABLE_FACT_BLOCKS`**(codex 修正方向)；⑥ **source-grounding 代码级校验**(引文确在学生输入里才落，codex #4)；⑦ capture-OFF 回归门是 MEMORY_CAPTURE + GEORGE_OBSERVE 都关(codex #3 修正)。
- **CODEX:** 找出 review 漏的 5 条实质项(consent 只 gate 写不 gate 读、consent fail-mode/backfill 未定、source-grounding 缺、语义去重弱、compaction 假设)——前两条并入决定①、source-grounding 成决定⑥；语义重复 + block 膨胀 记入 §8 风险。
- **CROSS-MODEL:** eng-review 判 CLEAR，codex 判 REVISE；分歧点(consent 语义、source-grounding)已通过补决定收敛。
- **强制回归（IRON）：** MEMORY_CAPTURE + GEORGE_OBSERVE 都关 → byte-identical。
- **PROD 前置：** bia-admin `consent_memory` migration + onboarding 采集 + heartbeat 在跑(防 block 膨胀)。
- **UNRESOLVED:** 无。
- **VERDICT:** ENG CLEARED（含 codex 收敛）— 可实现。注意这是本会话唯一带**跨仓前置**的计划：consent migration 没落地前 capture 不能上 prod；update_memory 工具半边无此依赖、可独立。
