# Plan：Spectrum 轰炸守卫 — 滥用冷却 + 拆句合并（HFQA）

**日期：** 2026-06-24
**一句话目标：** 在 Spectrum（生产 iMessage 路径）上分两层处理"连续多条消息"：① 真·滥用/刷屏 → 检测后给 5–10 分钟**冷却**（一句劝退后静默、零成本）；② 习惯性把一句话拆成几条发 → **不丢内容、整段一次连贯作答**。全部藏在默认关的 `SPECTRUM_BURST_GUARD_ENABLED` 后面，不开则与现在 byte 一致。
**设计来源：** judge-panel 设计评审（wf_f347f192）+ plan-eng-review 取舍。推荐方案 = **HFQA（hold-and-fold + quiet-abort + sliding-rate cooldown）**。

---

## 0. 决定（已拍）
1. 拆句合并用 **abort-then-refold**（不是排队按序回）。排队会先把第一条孤立地答了 —— 正是 Bobby 的 abort 要避免的"过时回复"，且变成 N 条啰嗦回复。
2. **直接做**，藏默认关 flag 后、保住 Bobby 原意，PR 里请 Bobby review（不预先打招呼）。
3. 这是设计计划，先过目再写代码。

---

## 1. 现状（grounded，seam map wf_f347f192 核实）

所有并发逻辑在 `src/adapters/spectrum.ts` 的 `runSpectrumLoop`（`:68` 起），**进程内、每连接一份、重启即清**：

| 事实 | 位置 |
|---|---|
| 去重 `seen` Set（cap 2000） | `:60,75,142-146` |
| per-sender 合并缓冲 `buffers`（1.5s debounce） | `:76,154-164` |
| 在途回合 `inflight: Map<senderId, AbortController>` | `:82` |
| **SUPERSEDE/ABORT**：新消息来 → abort 在途回合 | `:152-153`（Bobby `6653cc9`） |
| flush()：建 AC + 注册 inflight → stageGenerate（`buf.texts.join('\n')` @ `spectrum-stages.ts:86`） | `:89-138`,`:93-94`,`:107` |
| **发送/存助手 门**：`if (out && !ac.signal.aborted)` —— abort 的回合不发、不存助手 | `:112` |
| **用户行存库**：在 `runOrchestratorText`（`:271-277`），**跑 orchestrator 之前**就存 `role:'user'`，内容 = 已 join 的 burst | `:271-277` |
| 助手行存库：仅当 `finalText` 非空 | `:314-320` |

**两个已知坑（评委挖出，本计划必须处理）：**
- **A. 数据丢失 = 当前 bug 根因**：被 abort 的回合**用户行已在 `:271` 存了**，但 `:112` 的 not-aborted 门让它不发、不存助手 → 只有最后一条的回合作答。前面几条在历史里只是没人答的 `[user]:` 裸行。
- **B. 限流在生产线上根本没接**：`rate-limiter.ts`（10 条/60s）**只接在 `/squad/draft`（`index.ts:372`）**，`/chat` + iMessage + Spectrum 全无。**CLAUDE.md 写的"`/chat` 限流 10 条/分"是过时的、假的** —— 顺带在本 PR 里改正这句。

**Bobby 的 abort 原意（保留它）：** 注释 `:78-81,130-132` —— 绝不发"过时、乱序"的回复。本方案仍 abort、仍用 `:112` 门压住发送，那条过时回复永远不会单独发出去。

---

## 2. 设计（两层，分别对应两种情况）

### 状态机（每 sender，flag ON）
```
                 inbound m
                    │
        ┌───────────▼─────────────┐
        │ A 层：冷却/滥用守卫        │   ← 最先，在 dedup/save/coalesce 之前
        │ now < cooldownUntil ?     │
        └───────┬───────────┬──────┘
            yes │           │ no
   (静默丢弃,    │           ▼
    不存/不调)   │   记一条到 per-sender 滚动计数器
                │           │
                │           ▼  持续≥3分钟、每分钟>30条不停? ──是── 进冷却(发1句劝退)
                │           │ 否(正常/情绪vent,即使猛发)
                │           ▼
                │   ┌───────────────┐
                │   │ B 层：合并/在途 │
                │   └──┬─────────┬───┘
                │  无在途│        │ 有在途 turn
                │       ▼        ▼
                │   入 buffer   refolds<MAX ? ── yes ── abort 在途(不发)
                │   (1.5s)      │                       把在途 texts 折回 buffer 头部
                │       │       │ no(到上限)             refolds++; 重启 debounce
                │       │       └── 不 abort，让在途跑完，本条入新 buffer(下回合)
                │       ▼
                │   debounce 到 → flush()
                │       │  stageGenerate(join texts) → 完成且 !aborted ?
                │       │            │ yes
                │       │            ▼  存【用户行(整段join) + 助手行】各一次；发送
                │       │            │ aborted → 啥都不存、不发（内容已折进下一回合）
                ▼       ▼
              (drop)  回复
```

### ① A 层 · 滥用 → 冷却（对应需求 1）
> **设计前提（重要）：George 的核心场景是情绪支持 —— 深夜一个学生连珠炮发"我好难受/面试挂了/我是不是很失败"，20+ 条/分钟在 fast-path 上完全正常。冷却绝不能打断一个正在崩溃的学生。** 所以冷却**不卡聊天节奏**，只兜底"持续病态流量"。两个让我们敢把线调高的事实：(a) B 层的合并已经把"猛发"的成本摁住了 —— 发得越快越折叠进同一回合，full-agent 回合不翻倍；(b) 情绪 vent 多走便宜的 fast-path，消息条数本就是很差的成本代理。所以 A 层是 anti-bot/防失控的**后备闸**，不是聊天限速器。

- **判信号（便宜、无 LLM、持续 + 高线）**：在**入站口 `spectrum.ts:152` 之前**按 `senderId` 判定。**计数复用 `rate-limiter.ts`（eng-review 定，DRY）**：把 `checkRateLimit(key)` 参数化为 `checkRateLimit(key, {max=10, windowMs=60_000})`，默认值保 squad-draft 行为 byte 不变；A 层用 `{max: SPECTRUM_BURST_PER_MIN, windowMs: 60_000}` 调它拿每分钟超限信号。规则 = **连续 ≥3 个超限分钟窗口（每窗 >30 条）不停** → 进冷却。一次情绪高峰冲到 25–30/分、一两分钟就回落 → 至多 1 个 strike、随干净窗口衰减回 0 → **不触发**；真机器人/恶意刷（常 100+/分或持续十几分钟）→ 几分钟内触发。
- **冷却行为**：进冷却时发**一句**学长口吻劝退（`reply.sendText`，无模型成本），置 `noticeSent`；此后窗口内每条**静默丢弃**（loop 顶端、dedup 之前 `continue`，不存用户行、不调模型）。到点下一条自动清除。
- **状态**：在 `runSpectrumLoop` 的 maps 旁加 `burst: Map<senderId, {strikes, lastWindowOver, cooldownUntil, noticeSent}>`（per-minute 计数走 rate-limiter；strikes/cooldown 这层自己存）。**进程内、重启即清**（对滥用够用，与 `rate-limiter.ts` 一致；重启免费重置可接受）。
- **Map 清理（eng-review 定，防泄漏）**：给 `burst` Map 加周期 sweep（或趟冷却过期顺手删），同 `rate-limiter.ts:27-32` 套路；**顺手把同样无限增长的现有 `lastReplyAt` Map（`spectrum.ts:87`）一起扫**。否则长进程每个见过的 sender 都累一个 entry、永不退出。
- **不走 `checkUsageAllowed`**：那个每条都触发、会每条重发劝退。自动冷却留在传输层；`checkUsageAllowed` 的 `reason:'cooldown'` 扩展**留给将来 admin 手动 timeout**（本期不做）。
- **可选更聪明信号（本期不做，记在此）**：reply-decoupled —— "完全无视 George 的回复、持续猛灌"比纯计数更准，但与合并层打架（突发期本就少回复）、实现更绕。先用"持续高线"，真实流量不够准再上。

### ② B 层 · 拆句 → 合并（对应需求 2）
- **`inflight` 升级**：`Map<senderId, AbortController>` → `Map<senderId, {ac, texts, refolds}>`。
- **中途 follow-up**：读在途 `texts` → `ac.abort()`（`:112` 门保证那条过时回复不单独发 → 保 Bobby 原意）→ 把在途 `texts` **前插**进新 buffer（在新消息之前）→ `refolds = prev+1`，重启 1.5s debounce → 下次 flush 用现有 `buf.texts.join('\n')` 把整段一次作答。
- **承重修法 —— 把用户行存库从 `runOrchestratorText:271-277` 挪到 flush()，并区分三态（eng-review 定）**：
  - **完成 OK** → 存用户行（整段 join 文本）+ 助手行，各一次。
  - **被 abort（被新消息取代）** → 啥都不存（内容已 refold 进下一回合）。这一刀杀掉双存（"first" 出现两次）、日限额计数虚增、模型误以为复读。
  - **orchestrator 真报错（throw，非 abort）** → **仍存用户行**（无助手行）。保住今天 `:268-270` 注释的故意保证"用户消息活过 orchestrator 崩溃"；只在"完成"存会丢这条消息，是回退。实现：在 flush 的 `catch/finally` 里按 `ac.signal.aborted` 判定 —— 非 abort 的失败仍存用户行。
  - 用户行内容 = `buf.texts.join('\n')`（flush 里就有 `buf.texts`，与 `stageGenerate` 喂给 `handleText` 的同一份）。
- **顺带修掉一个既有 bug（buildHistoryPrefix 重复）**：今天用户行在 `:271` 跑 orchestrator **之前**就存，而 `buildHistoryPrefix`（`orchestrator.ts:696-708`）取最近 10 条，于是**当前消息在 prompt 里出现两次**（`<conversation_history>` 末行的 `[user]:` + `args.text`）。挪到 flush 完成处后，当前消息不再在自身回合的 history 里 → **去掉这个重复**（args.text 仍带着它，不会缺）。原 §8 那条"需确认 buildHistoryPrefix"风险 → 已确认、是改进。
- **re-fold 上限 `SPECTRUM_MAX_REFOLDS=3`**：防"慢回合(30-50s) + 每 8 秒来一句"导致回合永远凑不齐、干等几分钟、每次 abort 烧 partial token。到上限 → 不再 abort，让当前回合跑完作答，新消息入新 buffer 走下回合（无损）。

---

## 3. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/adapters/spectrum.ts` | flag 读取一次；loop 顶端冷却守卫；`:152` 前接**参数化的 `checkRateLimit(senderId,{max,windowMs})` + strikes**；`inflight` 升级为 `{ac,texts,refolds}`；`:152-153` abort 改为 abort-then-refold；refold 上限；`burst`/`lastReplyAt` Map 加 sweep |
| `src/adapters/spectrum.ts`（`runOrchestratorText` `:271-277` + flush `:89-138`） | 用户行存库从 `:271` 移走，挪进 flush **三态**（完成→存用户+助手；abort→不存；error→仍存用户行，在 catch/finally 按 `ac.signal.aborted` 判） |
| `src/adapters/rate-limiter.ts` | **参数化**：`checkRateLimit(key, {max=10, windowMs=60_000}={})`，默认值保 squad-draft byte 不变；A 层传 `{max:30}` 复用。一套限流实现（DRY）。PR 里说明它过去只接 squad-draft |
| `src/config.ts` / `.env.example` | 新增 `SPECTRUM_BURST_GUARD_ENABLED`(默认 false)、`SPECTRUM_BURST_PER_MIN`(默认 30)、`SPECTRUM_BURST_STRIKES`(默认 3，连续超线分钟数)、`SPECTRUM_COOLDOWN_MS`(默认 5min,clamp 5–10)、`SPECTRUM_MAX_REFOLDS`(默认 3) |
| `tests/agent/spectrum.test.ts` | 见 §5 |
| `CLAUDE.md` | 改正"`/chat` 限流 10 条/分"那句过时描述 |
| `prompts/` 或就地常量 | 冷却劝退文案（过 voice-guard：em-dash + 否定对比，≤2 emoji） |

---

## 4. 阈值（全部 env 可调）
| 项 | 默认 | 说明 |
|---|---|---|
| `debounceMs` | 1500（不动） | 抬高它会给**每条**首回复加固定延迟，伤 fast-path |
| `SPECTRUM_BURST_PER_MIN` | 30 | 单分钟窗口超过此数算一次 strike。正常情绪 vent 即使猛发也很少持续 >30/分 |
| `SPECTRUM_BURST_STRIKES` | 3 | **连续**超线分钟数 → 进冷却（≈持续 3 分钟 >30/分才触发）。一次干净窗口清零 |
| `SPECTRUM_COOLDOWN_MS` | 5min | clamp 5–10 |
| `SPECTRUM_MAX_REFOLDS` | 3 | 慢回合细水流的 token 上限闸 |
| `rate-limiter.ts MAX_MESSAGES` | 10 / 60s（不动、不复用） | 仅 squad-draft 用，A 层不碰它 |

> 数字依据：用户确认正常 reply-by-reply 聊天（尤其情绪 vent）20+ 条/分钟可能，所以线设在 **>30/分 且持续 3 分钟** —— 约 2× 正常峰值且要求"不停"，正常一两分钟的高峰不触发，机器人/恶意刷几分钟内触发。Bobby 上线后按真实流量再拧。

---

## 5. 测试（IRON RULE：abort 行为有现成断言，必须按 flag 分叉）
- **OFF 路径等价**：`spectrum.test.ts:190-236`（现断言 `firstAborted===true`、`sent` 含 `REPLY-SECOND` 不含 `REPLY-FIRST`）—— flag 关时**逐字不变**。
- **ON 路径 refold**：构造 m1 起回合 → m2 中途到 → 断言：仍 abort，`REPLY-FIRST` **从不单独发出**，最终回复同时反映 m1+m2（`handleText` 收到 `"m1\nm2"`），且**存库被调用恰好一次、内容为 join**（假 sessionStore 断言 save 次数=1）。
- **ON 路径无双存**：被 abort 的回合 → 断言**零用户行写入**（杀掉计数虚增）。
- **【CRITICAL 回归 · IRON】orchestrator 报错仍存用户行**：注入一个 throw（非 abort）的 orchestrator → 断言用户行**仍被存**（无助手行）。保住 `:268-270` 的"活过崩溃"保证，这是三态决定的承重测试。
- **Map sweep**：塞入过期的 `burst`/`lastReplyAt` entry → 跑 sweep → 断言被清。
- **ON 路径冷却**：模拟**连续 3 个分钟窗口、每窗 >30 条**（用注入的时钟/计数，不真睡 3 分钟）→ 断言进冷却时**恰好一句劝退**，此后静默丢弃、零模型调用、不存用户行；到点自动解除。
- **冷却不误伤情绪 vent**：一个分钟窗口冲到 ~30 条、下个窗口回落 → 断言**不触发冷却**（strikes 衰减回 0）。
- **refold 上限**：连续 4 条慢回合 → 断言到第 3 次后让在途跑完、不无限 abort。

---

## 6. 灰度 / Rollout
- `SPECTRUM_BURST_GUARD_ENABLED` 默认 false，在 `runSpectrumLoop` 读一次。
- **关**：今天的路径（abort@152-153、无 fold、无限流、存库留 `:271`），byte 一致，老测试过。
- **开**：冷却守卫 + fold + 存库迁移 + refold 上限 全启。
- 先在本地/单用户开 → 观察日志（refold 次数、冷却触发）→ 再让 Bobby 在 prod 开。

---

## 7. NOT in scope / 老实说的边界
- **应用层冷却 ≠ 真 DDoS 防护。** 卡阈值发（如 9 条/分，永不超 10/60s）的攻击者，应用计数器拦不住，每条仍跑 orchestrator。**真 DDoS 是 Cloudflare WAF 那层的活**（George 本就在 CF Container 后）。本层是"成本闸 + 礼貌劝退"。
- **`/chat` 网页路径仍无限流** —— 本期只补 Spectrum。/chat 限流另起（复用 rate-limiter.ts）。
- **`checkUsageAllowed` 的 `reason:'cooldown'` 扩展（admin 手动 timeout、dashboard 可见）** —— 留 follow-up。
- **多设备/子 handle**：同人不同 sub-handle 时 fold 会漏交错、低估拆句 flood —— 已知局限。
- **进程重启清空冷却 Map**：滥用者免费重置 —— 可接受，与 rate-limiter.ts 一致。

---

## 8. 风险
- **慢回合细水流**：到 refold 上限前每条 abort 烧 partial token；上限 3 兜底，非彻底消除。
- **崩溃窗口（已收窄）**：三态存库后，orchestrator **报错**仍存用户行（保证不丢）；只有进程**真崩溃**（kill/OOM）卡在 flush 完成前才丢那一条 —— 比今天的双写窄。`buildHistoryPrefix` 重复问题**已确认并被本改动顺手修掉**（见 §2②），非风险。
- **flush 注册竞争**（`:93-94`，debounce 触发与 `inflight.set` 之间的空窗）：follow-up 落在空窗会既不 abort 也不 refold → 可能两个并行回合。**本期顺手收窄**：在 flush 起始处**同步**注册 `{ac,texts,refolds}`。
- **冷却文案略微 overpromise**：冷却期消息是丢弃不是缓冲，劝退措辞别承诺"稍后回复"。

---

## 9. 验证
- 单测见 §5。
- 集成：本地开 flag，①连发 3 条短句(<1.5s) → 一条连贯回复；②慢回合中途插一句 → 整段一次作答、第一条不单独出现；③持续猛刷(>30/分×3分钟) → 一句劝退后静默；④情绪 vent 式高峰(一分钟 ~30 条后回落) → **不**冷却、正常作答；⑤默认用户(flag 关) → 行为 byte 不变。
- 回归：`spectrum.test.ts` OFF 路径逐字通过。

---

## 10. 并行化
全部改动集中在 `src/adapters/spectrum.ts`（A 层 + B 层共用同一个 inbound loop 闭包状态），加 `rate-limiter.ts` 参数化一处。**顺序实现，无并行化机会**（两层强耦合于同一循环，分开做会互相踩 inflight/buffer 状态）。

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 issues, all resolved; 0 critical gaps |

- **GROUNDING:** 所有引用行号已对真实代码核实（`spectrum.ts` 的 :82/:94/:112/:152-153/:167/:271-277、`spectrum-stages.ts:86/:106`、`orchestrator.ts:696-708`、`rate-limiter.ts`）。准确。
- **决定（3）：** ①存库三态（完成→存用户+助手；abort→不存；error→仍存用户行，保住"活过崩溃"保证）；②参数化复用 `rate-limiter.ts` 计数（DRY，不再自滚计数器）；③`burst`+`lastReplyAt` Map 加 sweep（防泄漏）。
- **顺手修：** `buildHistoryPrefix` 当前消息在 prompt 里出现两次的既有 bug，被存库迁移自然修掉。
- **强制回归（IRON）：** orchestrator-throws-仍存用户行 + OFF-path-byte-identical。
- **UNRESOLVED:** 无。
- **VERDICT:** ENG CLEARED — 可实现。default-OFF flag、两层、三态存库、参数化限流、sweep，按 §5 测试分叉。
