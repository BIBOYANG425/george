# Plan：per-user 两档模型配置 + Admin 模型目录（A 案）

**日期：** 2026-06-21 ｜ **重新核对：** 2026-06-23（plan-eng-review）
**核对结论：** Bobby 的「整体架构重构」未落地（`main == origin/main`，无重构分支），原 grounding 仍有效（行号微漂，结构判断成立）。唯一真缺口 = **多 agent 路径下 sub-agent 的取模**；orchestrator / trunk / single-agent 三条单模型路径今天就已经认 per-user 主模型（`orchestrator.ts:869-870`）。
**决定（已拍）：** A 案 — Provider + 密钥留 env（永不进 UI/DB）；Admin 只负责「看有哪些模型 + 授权每个用户用哪些」。授权粒度 = **两档：主模型 + 情绪模型**。
**一句话目标：** 后台能给每个用户分别指派「主模型」（跑 orchestrator + sub-agents）和「情绪模型」（跑 fast-path 快速回复），下拉只列**当前 env 里真上线**的模型；加新 Provider（如 OpenAI）= 开发写 adapter + Bobby 设 env key，后台自动识别，不碰密钥。

---

## 0. 设计原则
1. **密钥永不离开 env。** Admin 不存、不传、不显示任何 API key。"配置模型" = 在已上线的模型里授权，不是注册带密钥的新 Provider。
2. **"自动识别" = env 派生。** 一个模型只有它依赖的 env 变量全在场时才"可用"，下拉只列可用的。设个 key → 模型自动出现，零 UI 改动。
3. **复用现有机制，不另起炉灶。** per-user 控制存储（`data/user-controls.json`）、`resolveModelForUser`、`/admin/api/*`、`controlsPanel()` 已经在，扩它们。
4. **两档对齐两条已存在但分离的取模路径。** 主模型 → agent 取模路径（`resolveModelForUser`）；情绪模型 → fast-path 取模路径（今天完全没旋钮）。

---

## 1. 当前现状（grounded，地图 wf_72812c69 核实）

| 事实 | 位置 | 影响 |
|---|---|---|
| per-user 选**主模型的顶层 turn 已端到端通了** | 下拉 `GET /admin/api/models` → `modelOverride` 存 `data/user-controls.json` → `resolveModelForUser(userId, fallback)` @ `user-controls.ts:161-166` 套到 orchestrator `orchestrator.ts:869-870`（喂进 `buildQueryOptions`） | 主档顶层是补缺口，不是从零 |
| 模型下拉是 env 临时拼的，**没有真正目录** | `getModelChoices()` `user-controls.ts:226-256`（只 FAST/SMART/CLI 默认 + 可选豆包） | 缺口①：要建 catalog |
| **情绪模型无法控** | `fastReply()` `fast-path.ts:64-92` 在 `resolveModelForUser` 之前跑，自有取模逻辑（豆包 or lightweight），无视 per-user | 缺口②：fast-path 加 per-user 旋钮 |
| **sub-agent 不认 per-user 主模型（两条 dispatch 路径都中招）** | find-people/whats-happening→FAST、know-things→SMART 直接吃；`def.model` 在 `orchestrator.ts:506` 转发，`buildAgentsConfig`（`:460-510`）**和** `buildTrunkAgentsConfig`（`:414-424`）都不读 per-user override | 缺口③：默认多 agent **和** trunk-hybrid 两条路径都要贯通主模型；single-agent 无 dispatch、免疫 |
| Provider 路由按 model-id 前缀，env 覆盖 | `providerEnvForModel`/`providerOptionsForModel` `model-providers.ts:13-56`，`PROVIDERS[]` 目前仅豆包 | 加 Provider = 加 match + env() |
| **Agent SDK 只说 Anthropic 协议** | SDK query() 走 `ANTHROPIC_*` env 覆盖 | OpenAI 当主模型需网关（见 §6） |
| 模型 id 校验已是 Provider 无关 | `MODEL_ID_RE` `user-controls.ts:158`，已含 `gpt-/o[0-9]/gemini-/deepseek/doubao/ark-` | OpenAI/Gemini id 已能过校验 |
| 控制存储跨进程 3s TTL，需挂卷才存活 | `user-controls.ts:32,59-91` | per-user 模型同样靠 `/app/data` 卷 |

---

## 2. 设计（4 层）

### ① 模型目录 `src/agent/model-catalog.ts`（新）
```ts
export type ProviderId = 'anthropic' | 'doubao' | 'deepseek' | 'kimi' | 'openai';
export type Tier = 'main' | 'emotional';

export interface CatalogModel {
  id: string;            // 传给 query()/fast client 的真实 model id
  label: string;         // 后台显示名（中文友好）
  provider: ProviderId;
  tiers: Tier[];         // 这个模型能服务哪档
  requiresEnv: string[]; // 全部在场才算"上线"
}

export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', tiers: ['main','emotional'], requiresEnv: ['ANTHROPIC_API_KEY'] },
  { id: 'doubao-seed-1.6',   label: '豆包 Seed 1.6（主）',  provider: 'doubao',    tiers: ['main'],            requiresEnv: ['DOUBAO_API_KEY'] },
  { id: 'doubao-seed-2-0-lite-260215', label: '豆包 Seed 2.0 Lite（情绪）', provider: 'doubao', tiers: ['emotional'], requiresEnv: ['DOUBAO_API_KEY','DOUBAO_MODEL'] },
  { id: 'deepseek-chat',     label: 'DeepSeek',          provider: 'deepseek',  tiers: ['main','emotional'], requiresEnv: ['ANTHROPIC_BASE_URL'] /* 指向 deepseek 网关时 */ },
  // OpenAI：先只挂 emotional（main 待网关，见 §6）
  // { id: 'gpt-4o-mini', label: 'GPT-4o mini（情绪）', provider: 'openai', tiers: ['emotional'], requiresEnv: ['OPENAI_API_KEY'] },
];

export function availableModels(tier: Tier): CatalogModel[] {
  return MODEL_CATALOG.filter(m => m.tiers.includes(tier) && m.requiresEnv.every(k => !!process.env[k]));
}
```
> `getModelChoices()` 改为基于 catalog（保留 "自定义…" 兜底 + `MODEL_ID_RE` 校验，向后兼容手填 id）。

### ② per-user 两字段 — 扩 `UserControls`（`user-controls.ts:34-55`）
```ts
// 新增：
mainModel: string | null;       // 旧 modelOverride 重命名（读时向后兼容 modelOverride）
emotionalModel: string | null;  // 全新：fast-path 用
```
- **数据迁移：** 读 store 时 `mainModel ??= modelOverride`；写时两个都落，旧 key 保留一段时间。旧 `data/user-controls.json` 行不破。
- `MODEL_ID_RE` 已够用，不改。

### ③ 两处 wiring
- **主模型（补 sub-agent）：** `resolveModelForUser` 已覆盖 orchestrator / trunk / single-agent 的**顶层** turn。缺口在**两条 dispatch 路径的 sub-agent**：默认多 agent（`buildAgentsConfig` @ `orchestrator.ts:460-510`，`def.model` 在 `:506` 转发）**和** trunk-hybrid（`buildTrunkAgentsConfig` @ `:414-424`，它包 `buildAgentsConfig` 只删 know-things，find-people/whats-happening 仍吃 FAST）。落地：给 `buildAgentsConfig` 加一个 per-user 主模型参数，**仅当用户真有 override 时**把每个 sub-agent 的 `model` 覆盖成它（无 override 走 `def.model`，默认用户分层不变）；`buildTrunkAgentsConfig` 把同一参数透传。注意 build 顺序：`agentsConfig` 现在在 `:824` 先建（无 model 参数）、`resolvedModel` 在 `:869` 才算出来——要么把 build 移到 `:869` 之后传入，要么在 `buildQueryOptions` 默认/trunk 分支里重建/覆盖。single-agent 无 dispatch、天生已折叠、不动。**见 §5。**
- **情绪模型（全新旋钮）：** `fastReply({..., emotionalModel})`。内部按 id 路由：
  - 豆包/ark id + Doubao 配好 → `doubaoChat`
  - openai/gpt id → 新增 OpenAI 格式 fast 客户端（把 `doubao-client.ts` 的 OpenAI-format 调用泛化成 `openaiChat(baseUrl,key,model)`）
  - claude/anthropic id → `callLightweightLLM(..., {model})`
  - `null` → 今天的行为（Doubao 配好就豆包，否则 lightweight）。**OFF 路径必须 byte 不变**（§8.3）。
  - orchestrator 在调 `fastReply` 处（**实际 `:770-777`**，原 plan 写的 `:707-722` 已过时）加 `resolveEmotionalModelForUser(args.userId)`。该调用在 studentId 解析 + `resolveModelForUser` **之前**跑，只有 `args.userId`（原始 channel handle）可用，所以新函数必须按 `args.userId` 取，跟 `resolveModelForUser` 一致。
  - 路由正确性细节：`doubaoChat` 今天内部读 `process.env.DOUBAO_MODEL`（`doubao-client.ts:30`，没设就抛），要改成**收 model 参数**；`gpt-*` id 千万别丢给 `callLightweightLLM`（会被静默降级成 `moonshot-v1-8k` @ `llm-providers.ts:58`），得走新 `openaiChat`；`claude-*` id 走 `callLightweightLLM(..., {model})`（`wantsAnthropicModel` 会强制 Anthropic SDK）。四个分支都要保留 `NEEDS_AGENT` bail + `scanFabricationRisk` 防编造门（`fast-path.ts:102, 111-120`，model 无关）。

### ④ Admin UI — 一个下拉变两个（`dashboard-html.ts controlsPanel()` `:405-434`）
- 「主模型」select ← `GET /admin/api/models?tier=main`
- 「情绪模型（快速回复）」select ← `?tier=emotional`
- `ctrlBadges()` `:360` 两档都显示。
- 存 → `POST /admin/api/user/:id/controls { mainModel?, emotionalModel?, ... }`。

---

## 3. 数据结构 + 端点变更清单

| 项 | 变更 |
|---|---|
| `UserControls` | +`mainModel`、+`emotionalModel`（`modelOverride` 保留为兼容别名） |
| `GET /admin/api/models` | 加 `?tier=main\|emotional`，返回 `availableModels(tier)` 映射成 `{id,label}` |
| `POST /admin/api/user/:id/controls` | 接受 `mainModel`、`emotionalModel` |
| `model-catalog.ts` | 新文件 |
| `fastReply` 签名 | +`emotionalModel?: string \| null` |
| `resolveModelForUser` | 读 `mainModel ?? modelOverride`；新增 `resolveEmotionalModelForUser` |

---

## 4. 改动文件清单

| 文件 | 改动 | PR |
|---|---|---|
| `src/agent/model-catalog.ts` | 新增 catalog + `availableModels` | PR-1 |
| `src/admin/user-controls.ts` | `UserControls` 两字段 + 迁移读 + `getModelChoices` 走 catalog + `resolveEmotionalModelForUser` | PR-1 |
| `src/admin/router.ts` | `/admin/api/models?tier=`、controls POST 收两字段 | PR-1 |
| `src/admin/dashboard-html.ts` | 两个下拉 + badge | PR-1 |
| `src/agent/doubao-client.ts` → 新 `openai-fast-client.ts` | 把 `doubao-client.ts` 的 OpenAI-format 调用泛化成 `openaiChat(baseUrl,key,model)`（**不是** `llm-providers.ts`——那条是 Kimi/Claude 的 `callLightweightLLM`） | PR-2 |
| `src/agent/fast-path.ts` | `emotionalModel` 参数 + 路由 | PR-2 |
| `src/agent/orchestrator.ts` | 存储迁移 + resolver 重接；调 fastReply 传情绪模型（`:770-777`）；折叠贯通 sub-agent 主模型——`buildAgentsConfig`（`:506`）**和** `buildTrunkAgentsConfig`（`:414-424` + 调用点 `:614-619`）两条都改 | PR-2 |
| `src/agent/agents.config.ts` / `model-providers.ts` | sub-agent per-invocation 模型；（后续）OpenAI Provider | PR-2 / 后续 |
| `tests/*` | catalog env 过滤、两档 resolve、fast-path 路由、UI 序列化 | 各 PR |

---

## 5. 折叠决定（已拍：折叠）— 不只是心智，是 provider 路由的正确性要求
主模型覆盖后，该用户**一回合内 orchestrator + 所有 sub-agent 跑同一个解析出来的主模型**（放弃 fast/smart 内部分层，仅对被覆盖的用户；默认用户不变）。

**为什么必须折叠（关键）：** provider 路由的 env 覆盖（`providerOptionsForModel`）是**按 query() 整体设一次**的，取自 orchestrator 的 resolvedModel（`orchestrator.ts:609/638/655`）；但 sub-agent 各自带 `def.model`。若某用户主模型 = 非 Anthropic provider（如豆包），而该回合**派发到 sub-agent**（默认多 agent 路径），sub-agent 会拿着一个 Claude id 去打豆包的 base URL → 崩。**这是当前已存在的潜在 bug**（后台今天就能把 modelOverride 设成 doubao）。折叠成一个模型 → 整条 query() 的 provider env 一致 → 跨 provider 主模型才真能用，顺带修掉这个 bug。

- **代价：** 被覆盖的用户失去"便宜模型跑简单 sub-agent"的省钱分层。可接受（运营是按"整人换模型"在想）。
- **保分层的代价（已否决）：** 要为一条 query() 内的每个 sub-agent 重算 provider env，而 SDK 是 per-query() 设 env，做不到/很脏。
- **落地（pre-flight wf_9107cc35 核实，3 个坑）：** §3「把 mainModel 传给 sub-agent 的 `def.model`」从"可选"升为"必做"，且**必须覆盖两条 dispatch builder**：
  1. **两条路径都改：** `buildAgentsConfig`（`:460-510`，转发点 `:506`）**和** `buildTrunkAgentsConfig`（`:414-424` + 调用点 `:614-619`）。trunk 是 `buildAgentsConfig` 的薄包装，只有当 `buildAgentsConfig` 加参数 **且** `buildTrunkAgentsConfig` 透传时才修得到；只改前者、不更新 trunk 调用点 → trunk 路径（`GEORGE_TRUNK_HYBRID`）静默带 bug 上线。trunk dispatch 间歇（只 squad/events intent 才派发），是这个 bug 最会藏的地方。
  2. **只在真有 override 时折叠：** `resolveModelForUser` 把"有 override"和"取默认"都塌成一个字符串。若按解析后的值折叠，**默认用户会丢 fast/smart 分层**（know-things 静默从 SMART 掉到 FAST）。要传"原始 override-or-null"（`getUserControls(userId).mainModel ?? null`，或让 `resolveModelForUser` 返回 `{model, isOverride}`），非 null 才覆盖 `def.model`。
  3. **build 顺序：** `agentsConfig` 在 `:824` 先建好（无 model）、`resolvedModel` 在 `:869` 才有——光给 `buildAgentsConfig` 加参数不会生效，因为到默认分支的是 `:824` 那份预建配置。要么重排、要么在 `buildQueryOptions` 内重建/覆盖。
- **必须有跨 provider 回归测试，且跑在默认多 agent + trunk-hybrid 两条上**（见 §8.1）。

---

## 6. OpenAI 的硬约束（路线图）
- **情绪档：零成本。** fast-path 本就是 OpenAI 格式调用，加 `openaiChat` + catalog 一行 + `OPENAI_API_KEY`，后台自动出现。
- **主档：需网关。** Agent SDK 只说 Anthropic 协议；OpenAI 当主模型要么挂 Anthropic↔OpenAI 翻译网关（设 `ANTHROPIC_BASE_URL`，同 DeepSeek 套路），要么改 SDK。**本期 OpenAI 只进情绪档**，主档待网关另起。

---

## 6.5 NOT in scope（本期明确不做）
- **heartbeat 的 per-user 模型**：heartbeat 走 `createDeepSeekClient`（`llm-clients.ts:23-64`）手写的 OpenAI-format **function-calling 循环**（`tool_choice:required`），不是 Agent SDK。要让它认 per-user 主模型，得为它建一套 per-provider 工具调用抽象（Claude 的 tool-use ≠ DeepSeek/OpenAI 的 function-calling），代价远超 reactive 路径（后者靠 base-URL 切换免费拿到），收益还低（内部后台作业，用户听不到它的模型）。**目标句已去掉 heartbeat。** 将来要做是独立 PR，且**不蹭** PR-2 的 `openaiChat`（那是 chat-completion，heartbeat 要 function-calling）。
- **OpenAI 当主模型**：见 §6，待 Anthropic↔OpenAI 翻译网关。
- **模型变更审计**：谁改了某 user 的模型只有 `updatedBy`，不单独留痕（§9）。
- **后台 eval/classify 取模**（relationship evaluator + compaction 的 `callLightweightLLM(config.models.smart)`）：内部判断调用，不归 per-user 模型管。

---

## 7. PR 拆分（pre-flight 修正了一处自相矛盾）
> **原 §3/§4/§7 把 `resolveModelForUser` 改读 `mainModel` 也塞进了 PR-1**，并在 §7 同时写"不改执行路径"+"主档立即生效"——自相矛盾。pre-flight 核实：若 PR-1 就让 resolver 读 `mainModel`，新「主模型」下拉里选个非 Anthropic 主模型**下一回合就上线**、撞上 PR-2 还没修的跨 provider sub-agent bug → 崩。**所以 resolver 重接 + 折叠整体挪到 PR-2，两者必须一起上。**

- **PR-1（目录 + 存储 + UI，真·零执行路径变更）：** `model-catalog.ts` + `UserControls` 加 `mainModel`/`emotionalModel`**两个休眠字段** + `getModelChoices` 走 catalog + `/admin/api/models?tier=` + 两下拉 UI + badge。
  - **不变量：`resolveModelForUser` 在 PR-1 里继续只读 `modelOverride`、不动。** 「主模型」下拉沿用现有 live 字段（`modelOverride`）写入，所以后台现有换模型能力**不回退**；「情绪模型」下拉写新的 `emotionalModel` 字段（休眠，运行时没人读）。新字段只落盘 = 休眠。
  - 结果：后台能看/能存两档、UI 就位，主档照旧工作，情绪档不接、主档不重接。真低风险。
- **PR-2（执行接线，一起上）：** ① 存储迁移 `modelOverride`→`mainModel`（读时 `mainModel ?? modelOverride` 兼容旧行）+ `resolveModelForUser` 重接读 `mainModel`；② 折叠：`buildAgentsConfig` **和** `buildTrunkAgentsConfig` 两条 dispatch 都把 sub-agent `model` 覆盖成 per-user 主模型（仅 override 用户，见 §5）；③ fast-path 情绪模型路由 + 泛化 `openaiChat`；④ **强制跨 provider 回归（§8.1）跑默认多 agent + trunk-hybrid 两条**。改执行路径，重点测。
- **后续（解耦）：** OpenAI 主档网关。

---

## 8. 验证
> 注意基线：`user-controls.ts` 与 `fast-path.ts` 的取模/回复路由**今天零测试覆盖**（只有 `model-providers.test.ts` 测了 provider 路由本身、`fast-path-guard.test.ts` 测了防编造扫描）。本期新增的分支没有现成回归网，单测要从头补。

- 单测：`availableModels` 按 env 过滤（设/不设 key、两 tier、空结果）；`resolveEmotionalModelForUser` 路由到正确客户端（doubao/openai/claude/null 各一）；`getModelChoices` 走 catalog + 自定义 id 经 `MODEL_ID_RE` 放行/拒绝；两档 POST 往返。
- 集成：后台给某 user 配「主=Claude、情绪=豆包」，发一条情绪消息走豆包、发一条查询走 Claude，日志确认。

### 三条**强制**回归（IRON RULE，不可跳过）
1. **跨 provider 主模型 + sub-agent 派发（默认多 agent + trunk-hybrid 两条都测）**：某 user 主模型=豆包，发一条会派发到 sub-agent 的事实查询 → sub-agent **也跑豆包**（不是拿 Claude id 去打 Ark base URL）。可用现有 `buildQueryOptions` + baseInputs 夹具（参考 `tests/agent/trunk-hybrid.test.ts`）断言：`options.agents` 每项 `model === 豆包 id === options.model` 且 `options.env` 把 `ANTHROPIC_BASE_URL` 指向 Ark；`trunkHybrid:true` 跑同一套（今天会失败：sub-agent = `claude-sonnet-4-6`）。**single-agent 结构免疫、别拿它当通过证据。** 再加一条无 override 等价断言：默认用户 → sub-agent model 跟今天 byte 一致（FAST/SMART）。
2. **`UserControls` 迁移**：现有 `data/user-controls.json` 里只有 `modelOverride` 的行 → 读回来是 `mainModel`，不丢数据；写时两 key 都落。保护线上配置不在部署时丢。
3. **`emotionalModel = null`（未配置用户）**：fast-path 行为 byte 不变（豆包配好就豆包、否则 lightweight）。可复用现有 OFF-path 等价测试的套路。

## 9. 风险 / 运维
- per-user 模型设置同样靠 `/app/data` 卷，不挂卷重部署即丢（沿用现有控制的限制）。
- catalog 与 env 不一致（写了 catalog 行但没设 key）→ `availableModels` 自动隐藏，安全。
- 无审计：谁改了某 user 的模型只有 `updatedBy`，不单独留痕（沿用现状，可后续补）。
- 折叠主模型 → 该用户失去 fast/smart 省钱分层（§5 已述）。

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | re-grounded 2026-06-23; collapse + heartbeat-drop decided; file-table fix; 3 mandatory regressions added |
| Pre-flight (adversarial) | Workflow `wf_9107cc35` | Verify claims before coding | 1 | 2 blockers found + fixed | bug CONFIRMED 9/10; PR-1-inert PARTLY 8/10; gap-on-multi-agent-only PARTLY 9/10 |

- **RE-GROUNDING:** Bobby refactor never landed (`main==origin/main`); grounding valid (line numbers drifted, structure holds).
- **DECIDED:** §5 = collapse (provider-env correctness, fixes a pre-existing cross-provider bug); heartbeat dropped from scope.
- **PRE-FLIGHT (10-agent, 770k tok) caught + fixed two blockers:** (1) PR-1 as written was NOT exec-path-inert (§3/§7 scoped the live resolver repoint into PR-1, self-contradiction) → fixed: resolver stays on `modelOverride` in PR-1, repoint+collapse moved entirely to PR-2; (2) collapse must cover `buildTrunkAgentsConfig` too (trunk-hybrid has the identical bug) → added to §3/§5/§7/§8. Stale line refs corrected (fastReply `:770-777`, resolve `:869-870`).
- **IMPL GATE:** the cross-provider regression (§8.1) MUST pass on BOTH the default multi-agent AND trunk-hybrid paths (single-agent is structurally immune — a green test there is false confidence).
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — PR-1 is now genuinely inert (catalog + storage + UI, resolver untouched, new fields dormant); ready to implement, then PR-2 (migration + resolver repoint + collapse on both dispatch builders + emotional wiring, all together, gated on §8.1).
