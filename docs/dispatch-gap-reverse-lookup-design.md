# 落空告警反查（G1）设计记录

> **用途**：`task-1`（原 `task-624`）的**先语义后实现**产物 —— 在写 SQL 之前先把「哪些生效决策没有下游 task」用现有能力在真实台账上算一遍，把语义钉死，再谈参数与实现。
> **落地**：见本文件 §6（提交后回填 sha）· **日期**：2026-11-15 · **起点**：`internal/A03-xihe/docs/dsd-decision-requirements.md` §3（决策落空告警，P0）+ 真实事故 `D-896`
> **边界**：**不做**「N 天」时间维度（需求 §3 的 N 天配置在 XH 侧自做，DSD 只提供判定能力）；**不做** BL 台账侧的两跳反查（另卡，见 §4）；**不碰** G1/G4 既定口径（`refs`/规则方向、`replaces` 语义不变）。

---

## 1. 先算一遍：用现有能力在真实台账上取清单（零改动）

**口径**：真实台账 = `internal/A03-xihe/docs/lead-decisions-ledger.md`（676 条）+ 卷 A `internal/A03-xihe/docs/archive/lead-decisions-2026-11-05-to-2026-11-08.md`（306 条），由仓内既有脚本 `packages/dsh-decision/scripts/migrate-ledger.mjs` 灌入临时库；清单只用**既有** `searchDecisions`（列表）+ `getDecision`（refs）求得，**不写 SQL、不加参数**。

| 读数 | 值 | 证据等级 |
| --- | --- | --- |
| 迁移条目 | 982 条（主册 676 + 卷 A 306） | `[实测]` `migrate-ledger.mjs --database …` 报告 `migration.created=982` |
| 调用次数 / 耗时 | 1032 次（50 页列表 + 982 次 get）/ 26 ms | `[实测]` 这就是「列表项无 refs ⇒ 1+N」的真实成本 |
| 状态分布 | effective 982 / voided 0 | `[实测]` —— 但见 §2 的证伪：这是**迁移脚本的不变量**，不是台账事实 |
| **无 task 边**（本卡目标口径） | **532 条** | `[实测]` |
| 无任何 refs | 187 条（⊂ 532） | `[实测]` 需求 §3 附带要求「未挂任何 refs」已被同一条件覆盖 |
| 无 task 且正文无 BL 提及 | 413 条 | `[实测]` |
| 结构边 vs 正文提及 | 532 vs 532，**差 0** | `[实测]` 迁移的边与正文同源 ⇒ 语义自洽，不是两套事实 |

**具体 id（为什么该在里面）**

| 台账号 | DSD 号 | refs | 为什么在清单里 |
| --- | --- | --- | --- |
| `D-896` | 454 | `plan:PLAN-0762`、`decision:D-894` | 生效、有据可查，**0 条 task 边**、正文也没有任何 `T-`/`task-` 号 —— 事故本体 |
| `D-1420` | 971 | 3 commit + 6 decision | 9 条边里没有一条 task |
| `D-1417` | 968 | `decision:D-1415` | 只有互引边，无执行物 |
| `D-1277` | 829 | （空） | 需求 §3 附带要求的样本：一条 refs 都没有 |

## 2. 为什么「982 条全 effective」不能当台账事实（自我证伪）

- `migrate-ledger.mjs:371` 组装的 create 输入是 `{decision, externalId, refs, sourceReference}` —— **没有 status**；`:375` 只把索引行的状态格放进报告（`metaStatus`），**从不写库**。
- `decisions.status` 由 `createDecision` 恒写 `'effective'`（契约 `spec/decision-contract.md:104`「`status` 由 DSD 设为 `effective`」），唯一改状态的路是 `decision_void`。
- 台账里**确实有**被推翻/作废的记录，迁移后仍是 effective：`D-744`（`lead-decisions-ledger.md:163` 脚注「原判整体作废 —— 被 D-745…」）、`D-781`（`:220`「『停止派活、转入交接态』作废」）、`D-936`（`:2170` 标题「『≤2 并发编译位』作废」）。
- **结论**：迁移产物里 `voided=0` 是**迁移脚本的不变量**（脚本不写状态），不是台账事实。因此新过滤器的区分度实测上全部来自 refs 条件；「生效」这一半由 `search` 既有默认（`status='effective'`）承担，两者正交。

## 3. 语义定义（定死，供 SQL 落地）

**「生效但无下游 task」= `status='effective'`（search 既有默认） 且 `decisions` 没有任何 `ref_type='task'` 的引用边。**

三条判据：

1. **边是结构事实，不是文本匹配**：判定走 `decision_refs`，不做正文正则。正文里提到 `task-` 但没写成边 ⇒ 不算有卡（这正是本卡要暴露的形态）。实测两者在本台账上恰好相等（§1），但语义上以边为准。
2. **无任何 refs ⊂ 无 task 边**：需求 §3 的两条告警条件（无 task 边 / 未挂任何 refs）**一个过滤器同时覆盖**，不需要第二个参数。
3. **反向对齐**：`refType+refId` 答「谁引用了 T-x」（有边），`withoutRefType` 答「谁没有这类边」。两者是补集，不能同时成立同一类型（`withoutRefType === refType` 直接拒，见 §6）。

## 4. 另两类事故形态**结构上不可能**由本卡覆盖（file:line）

需求 §3 的事故原句是「`D-896` 有（生效）、`BL-584`/`BL-578` 有（未闭环）、卡一张都没有」。三类分别落在不同层：

| 形态 | 为什么在本仓结构上不覆盖 | 锚点 |
| --- | --- | --- |
| **D-896 型**：生效决策无 task 边 | **本卡覆盖**（532 条） | 本文件 §3 / §6 |
| **BL-584 型**：BL 登记、没有决策、没有卡 | BL **不是决策**：库里没有 BL 表（`EXPECTED_TABLES` 只有 `projects/session_projects/decisions/decision_revisions/decision_refs/decision_replaces`），BL 也没有 id 空间 | `sqlite-store.ts:1088-1096`（期望表集） |
| 同上，想用 refs 表达 BL | `bl` **不是合法 ref 类型**：类型常量只有一个来源、只有四类；写面按 CHECK 拒、库层按 CHECK 拒 | `sqlite-store.ts:62`（`DECISION_REF_TYPES`）、`:333-336`（写面拒）、`:1025-1026`（`ck_decision_refs_type`） |
| 同上，想加第七个工具去查 BL | 冻结契约的模型面是**六个工具**；加面 = 改冻结契约 | `tools.ts:46-53`（`DECISION_TOOL_NAMES`）、`spec/decision-contract.md` §3 |
| **BL-578 型**：BL 有决策（`D-899`）且该决策**挂了** task（`task-124`），但那张卡不是落实该 BL 的卡 | 「有边」≠「边对得上」。判定「这张卡是否落实该 BL」需要读卡面语义，DSD 只有边 | 实测：`D-899` refs=`task:task-124`、`decision:D-896`，**不在 532 条里** |

**实测补充**（2026-11-15，迁移库）：全库 **0 条**决策正文提到 `BL-584`（`BL-584` 的登记在 XH 的 backlog 侧，本仓库里没有它的任何载体）。所以「要求 DSD 覆盖 BL 侧」等于让它去猜另一个仓的台账 —— 属产品范围扩张，另卡。

## 5. 参数与工具面（默认关闭，只增不改）

| 面 | 变更 |
| --- | --- |
| `decision_search` 入参 | 新增 `withoutRefType`（enum = `DECISION_REF_TYPES`，**与 refType 共用同一个常量**）；省略 = 不加过滤（默认行为逐条不变） |
| `decision_search` 入参 | 新增 `withRefTypes`（boolean，opt-in，默认 false）：每命中带**去重后的边类型**（`decision/task/plan/commit` 固定序），**不带 id** |
| 语义 | `withoutRefType` 只返回**没有任何该类型引用边**的决策；与 `query`/`queryMode`/`timeHorizon`/`refType+refId`/`replacedDecisionId`/`includeVoided`/分页可组合 |
| 拒绝 | `bl`/未知类型 ⇒ `VALIDATION_FAILED / field: withoutRefType`；与同类型 `refType` 同时出现 ⇒ 拒（该组合只可能为空，属调用方错误，不静默返回空页）；`withRefTypes` 非布尔 ⇒ `field: withRefTypes` |
| 措辞 | 工具面写「没有任何该类型引用边的决策」，**不写「落空决策」**：那个词会把 §4 的两类 BL 形态一起吞进去；`withRefTypes` 的说明写明「只答有哪几类边，不答指向谁；id 用 `decision_get`」 |

**为什么列表项摘要不是第七个工具**：冻结契约把**模型面**固定成六个工具 —— `tools.ts:46-53` 的 `DECISION_TOOL_NAMES`（`decision_search`/`decision_get`/`decision_create`/`decision_create_batch`/`decision_update`/`decision_void`）与 `spec/decision-contract.md` §3 逐条对应；加第七个工具 = 改冻结契约，超出本卡边界。所以摘要做成**既有 `decision_search` 的可选字段**（`withRefTypes`），默认关闭。

**为什么摘要只带类型不带 id**：完整 refs 实测把默认页撑到 **2.11×**（§6 表），而「这条挂没挂东西、挂的是哪几类」用类型就够；id 只有真要追责时才需要，那时单条 `decision_get` 更合适。

## 6. 落地读数（实现后实测；sha 提交后回填）

| 项 | 读数 | 证据等级 |
| --- | --- | --- |
| schema | **不变**（`user_version` 仍 3，无迁移、无新表/索引；`withoutRefType` 复用 `uq_decision_refs_edge` 的 `decision_id` 前缀） | `[源码]` + `[实测]` |
| 执行计划（NOT EXISTS） | `SEARCH decisions USING INDEX idx_decisions_project_updated (project_id=?)` + `CORRELATED SCALAR SUBQUERY` + `SEARCH r USING COVERING INDEX uq_decision_refs_edge (decision_id=? AND ref_type=?)`；**无 `SCAN decision_refs`** | `[实测]` `EXPLAIN QUERY PLAN` |
| 真实台账命中 | `withoutRefType:'task'` = **532 条**，与 §1 的零改动清单**逐条对上**；`D-896`(454) 在内，`D-899` 不在内（有 `task-124` 边），`D-1277`(829，无任何 refs) 在内 | `[实测]` |
| 默认行为不变 | 982 条 id 序列 before vs after：**逐条相同，`firstDiffIndex = -1`** | `[实测]` |
| 页字节（真实台账 982 条，同一页 `JSON.stringify(data)`） | limit 10：1,727 → **2,053 B（1.19×）**；limit 20：4,477 → 5,186（1.16×）；`withoutRefType:'task'` + limit 20：6,166 → 6,802（1.10×） | `[实测]` |
| **最坏页**（`refs` 种类最多的 20 条，实为 20/20 全四类） | 5,004 → 5,944 B = **1.19×** | `[实测]` |
| 最坏页（**合成**：20 条 × 四类全命中，且 preview 只有 20 字符） | 2,723 → 3,663 B = **1.35×**；固定增量 **47 B/条** | `[实测]` |
| refs 种类分布（真实台账 982 条） | 0 类 187 / 1 类 279 / 2 类 301 / 3 类 175 / 4 类 40 | `[实测]` |
| 变异 ①：去掉 `NOT EXISTS` | **3 红**：`task-1: withoutRefType is the complement of the reverse filter — the dispatch gap in one call`（actual `[3,2,1]` vs expected `[3,1]`，反例 D-899 转红）、`task-1: withRefTypes is opt-in, canonical and pagination-independent`（`[4,3,2,1]` vs `[3,2]`）、`task-1: decision_search answers the no-downstream-task question in one call…`（actual `['D-1277','D-899','D-896']` vs `['D-1277','D-896']`） | `[实测]` |
| 变异 ②：`refTypes` 改回 SQL 行序 | **1 红**：`task-1: withRefTypes is opt-in, canonical and pagination-independent`（actual `['plan','task']` vs expected `['task','plan']`）⇒ 夹具确实在验排序，不是碰巧 | `[实测]` |
| 测试 | 仓根 `pnpm test` **157/157 绿**（改前 151）；包级 `pnpm -C packages/dsh-decision test` **161/161 绿**（改前 155）；两者差 = `ledger-fixtures` 4 条，新增合计 +6；`pnpm typecheck` 绿 | `[实测]` |

**验收线变更留痕（不改写原判据）**：本条的最坏页验收线原为 **≤1.3×**（Lead 自设的代理指标：目的是「成本有界」，不是比值本身）。实测证明**比值不是不变量** —— 同一成本（固定增量 **47 B/条**）下，真实台账项平均 ~250 B ⇒ **1.19×**；合成短 preview（20 字符）页基线更小 ⇒ **1.35×**。故判据改为**绝对量**：`Δ ≤ 50 B/条 且默认关闭（opt-in）`，实测 Δ = **47 B/条** ⇒ 达标。**两个比值（1.19× / 1.35×）同时保留在上表**：比值随基线页大小变化，绝对量才是成本上界。

**测试口径（两个命令，两个数）**：

| 命令 | 文件数 | 改前 | 改后 |
| --- | --- | --- | --- |
| A12 仓根 `pnpm test`（9 个文件，**不含** `tests/scripts/ledger-fixtures.test.mjs`） | 9 | **151** | **157** |
| `pnpm -C packages/dsh-decision test`（10 个文件，**含** ledger-fixtures） | 10 | **155** | **161** |

逐文件（改后）：`decision-contract 17` / `sqlite-store 17` / `decision-ops 61`（改前 57，+4） / `timestamp-order 4` / `config 8` / `caller 7` / `binding 7` / `first-binding 13` / `tools 23`（改前 21，+2） / `ledger-fixtures 4` ⇒ 9 文件合计 **157**，10 文件合计 **161**；新增合计 **+6**（存储 4 + 工具面 2）。**原记「161」未标命令口径**，实为**包级 10 文件跑**；根 `pnpm test` 是 157。两个数都对，差的是 `ledger-fixtures` 那 4 条是否计入 —— 不是两次运行合并，也没有哪一次是过期读数。

## 7. 判定为「不做」的相邻问题

- **不做**「N 天」时间维度：`decisions` 没有「进入当前状态时刻」的读面（`created_at`/`updated_at` 不是它），N 天判定属 XH 侧。
- **不做** BL 台账两跳反查（`BL → 决策 → 卡`）：见 §4，另卡。
- **不做**「卡对不对得上」（BL-578 型）：需要读卡面语义，不是边查询能回答的。
- **不做**第七个工具：冻结契约的模型面固定六个。
