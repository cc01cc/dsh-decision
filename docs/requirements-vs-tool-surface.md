# DSD 需求 ↔ 六工具面 对齐表

> **状态**：~~对照结论（无实现改动）~~ **已被 2026-11-14 复核取代** —— 当时判「完全不存在」的 4 条**已全部实现**，见 [§1.1](#11-2026-11-14-复核4-条全部已实现task-592-复核产出) · **原日期**：2026-11-13（`task-330`）· **复核**：2026-11-14（`task-592`）
> **对照对象**：`internal/A03-xihe/docs/dsd-decision-requirements.md`（用户经 Lead 转交的需求清单，XH 侧维护）
> **对照面**：本仓六个工具 + 存储层 schema（`packages/dsh-decision/src`）
> **证据等级**：`[源码]` 读代码得 / `[实测]` 本机跑得（复算方式见 §5）/ `[推断]` 由前两者推论，未单独验证

---

## 0. 结论先行

第一句，最该先做的一条：

> ⚠️ **2026-11-14 复核：下面第 0/1 节是 11-13 的判断，四条现均以实现落地，见 §1.1。** 保留原文是因为「为什么它排第一」的推理仍然成立（也正是它被最先实现的理由）。
>
> **`create` 的外部幂等键 `external_id`。** 因为它是四件要务里**唯一一件「不做就会永久产生新脏数据」**的：其余三件做错了都能事后修（方向错了改、查询可后补、默认列表可后补），而重复写入**修不掉** —— 本插件**没有物理删除**，`decision_void` 只能作废，重复记录会永久占着 id 空间并出现在每一次搜索结果里。

第二句，必须先说清楚的**卡面前提有两处偏差**（不纠正就会答错题）：

| 卡面写的 | 文档实际的 | 处置 |
| --- | --- | --- |
| 「8 条需求逐条四态」 | 该文档 §7 自述「**现行结论在 §10，§1–§8 只作历史**」；§11 又按用户前提「**现在只解决眼下必要的问题**」重定，**最终只保留 4 条** | 两张表都给：§1 现行 4 条（权威）+ §2 历史 8 条（按卡面要求逐条给四态，并注明每条在现行版里的去向） |
| 「P0 是决策落空告警，今天到底有没有」 | 它在现行版里**作为 DSD 需求已被撤回**（§10.6「告警我们先自己做」+ §11「告警守护进程 第一期不要做」）；DSD 侧保留的是它的**底层能力**：§11 第 3 条「一条反向查询」 | **四态：判断为已作废（作为需求）+ 完全不存在（作为能力）**。见 §1 #3 与 §2 #3 |

两处偏差都**不是 Lead 写错**：卡面写于文档最后一次修订之前，是**文档自己在卡面之后改了口径**。这是「两边都真、接缝没人看」的第三种形态 —— **需求方自己改口径，执行方的卡面停在上一个版本**。

---

## 1. 现行口径：§11 保留的 4 条（权威表）

| # | 需求原文（不改写意思） | 现状 | 锚点 | 证据等级 | 实现顺序建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | 「`create` 接受**外部幂等键** `external_id`（我们给 `D-1120` / `BL-584`）」；判据：同一 `external_id` 重复 create ⇒ 返回已存在，不新建第二条 | **完全不存在** | `decisions` 表 15 列无该列（`sqlite-store.ts:333-362`，`PRAGMA table_info` 实测）；create 参数表（`host/tools.ts:305-318`）无该字段；传入即被拒：`VALIDATION_FAILED / Unknown field / field: externalId` 实测 ⇒ 不是「忽略」，是**显式拒绝** | `[源码]` + `[实测]` | **1（最先）**。改动面 = 一列 + 唯一索引 + create 与 create_batch 两处入参 + 一条仓储查重。**注意**：`decision_create_batch` 一次 ≤100 条且「全成功或全回滚」⇒ 848 行要 9 批，**批间中断仍会重复**，所以幂等键必须在批内与批间都生效 |
| 2 | 「`refs` 方向由类型约束：`decision` 不允许 `bl`；`bl` 允许 `decision`」；判据：写反方向的 create 被**拒绝** | **完全不存在** | 库里只有 4 张表（`projects` / `session_projects` / `decisions` / `decision_revisions`，实测）；`refs` 在 `src/` 全树 **0 命中**（源码）；最接近的 `source_reference` 是**自由文本**（`CHECK` 只校验长度 1–4000，`sqlite-store.ts:352`）⇒ **无类型、无方向、无法被约束** | `[源码]` + `[实测]` | **与 1 同批**：类型约束是 `refs` 列或关联表上的 CHECK，先有列才能约束。**排在 1 之后的理由**：迁移不搬 refs 也不会产生脏数据（漏搬可补），漏掉幂等键会产生重复 |
| 3 | 「一条反向查询：`query --refs-of <decision> --type task` 回答『这条决策有没有下游 task』」；判据：任意决策能答存在/不存在，且**不需要告警守护进程** | **完全不存在** | 六工具固定为 `decision_search` / `get` / `create` / `create_batch` / `update` / `void`（`tools.ts:44-51`，运行时打印实测）；`searchDecisions` 要求 `projectId` 且 `query` **必填**（空参实测 `VALIDATION_FAILED / Expected a string / field: query`）⇒ 不存在「不查关键词就能列」的入口，更没有反向遍历 | `[源码]` + `[实测]` | **3**。它**依赖 2**：没有 `refs` 就没有可反向遍历的边。**但可以先行**：先做 `refs` 列 + 反向索引，查询命令后补 —— 需求方原话也只要求「保证反向索引存在，不需要暴露成查询 API」 |
| 4 | 「两个可选字段：`time_scope`（临时/长期，**默认长期**）+ `replaces: [id]`（写在新条上，旧条不改）」；判据：默认列表能把「临时」与「长期」**分开列出**；新条能声明它取代谁 | **拆分：`time_scope` 已有但不达标；`replaces` 完全不存在** | **字段已有**：`time_horizon TEXT NOT NULL DEFAULT 'temporary' CHECK IN ('long_term','temporary')`（`sqlite-store.ts:344-345`）；入参 `timeHorizon`（`tools.ts:311` 可选、`:325` get 返回、`:396` update 可改）（源码）。**两处不达标**：① 默认值是 temporary，需求要**默认长期**（实测：不传该字段 ⇒ `timeHorizon` 为 temporary）；② **判据不可达**：`search` 的 `query` 必填，**根本不存在「默认列表」**；且搜索结果项只有 `decisionId / preview / status` 三个键，**不含 `timeHorizon`**，也无法按它筛选（把 `timeHorizon` 传给 search ⇒ `VALIDATION_FAILED / Unknown field`）（实测）。**`replaces` 完全不存在**：无列，入参被拒 `Unknown field / field: replaces`（实测） | `[源码]` + `[实测]` | **2**。`replaces` 与 1 同批便宜（一列 + 入参），但把默认值改成 long_term 是**行为变更**（存量行不受影响，只影响未来 insert）⇒ 要么同批加迁移默认，要么先只补「默认列表」这个读面 |

> ⚠️ **这张表是 2026-11-13 的快照，2026-11-14 已全部过时。** 下面 §1.1 是复核后的现状；**读现状请看 §1.1，不要看本表的「现状」列**。

**一句话读这张表**：4 条里**只有 `time_scope` 的字段层是现成的**（且默认值与判据都不达标），其余三条连列都没有。

### 1.1 2026-11-14 复核：4 条**全部已实现**（task-592 复核产出）

**结论：§1 表里的「完全不存在」四条，在 HEAD `f7eb936` 上全部落地。** 本表作废原因不是写错，是**写完之后 15 个提交**（`d4765ab` task-377 起）把它们实现了 —— 又一处「两边都真、接缝没人看」。**下一个人若照 §1 派活，会重复实现已有能力。**

| # | 判据（原表） | 现状（HEAD `f7eb936`） | 锚点 | 读数 |
| --- | --- | --- | --- | --- |
| 1 | 同一 `external_id` 重复 create ⇒ 返回已存在，不新建 | **已实现**（`d4765ab` task-377） | 列 `sqlite-store.ts:791-796`（`EXTERNAL_ID_COLUMN_SQL`）、`:869`（表内引用）、唯一索引 `:884`；入参 `host/tools.ts:319`（`sharedDecisionParameters`）、batch 同源 `:413`；查重 `sqlite-store.ts:1376-1384`（create，事务内）、`:1419-1449`（batch，含批内与批间） | `PRAGMA table_info` 17 列含 `external_id TEXT`；`uq_decisions_external_id ON decisions(external_id)`；连 create 两次 ⇒ `decisions` 仍 1 行，第二次 `decisionId` 相同 + `alreadyExisted: true`；848 行 9 批跑完再整轮重跑 ⇒ `createdCount 0`、`decisionId` 序列逐项相同、行数不变 |
| 2 | `refs` 方向由类型约束：decision 不允许 bl；写反方向被拒 | **已实现**（`d4765ab` task-377；`afc0f6f` task-405 追加） | `decision_refs` 表 `sqlite-store.ts:911-925`（`ck_decision_refs_type` 闭集 `decision/task/plan/commit`）、方向校验 `:285`、反向索引 `:888` | 传 `refs:[{type:"bl"}]` ⇒ `VALIDATION_FAILED`，`field: refs`，消息点名方向规则；`refs:[{type:"task",id:"T-194"}]` 写入后 `get` 返回该边；`search{refType:"task",refId:"T-194"}` 命中那条、不命中无关条 |
| 3 | 一条反向查询，回答「这条决策有没有下游 task」 | **已实现**（`f7a0bde` task-393） | `getDecision` 返回 `refs` `sqlite-store.ts:1488-1494`；反向过滤 `refType/refId` `:473-560`、`:1515-1517`（走 `idx_decision_refs_reverse`）；工具面 `tools.ts:357-365` | 见第 2 行读数；无需第七个工具、不依赖告警进程 |
| 4 | `time_scope` 默认长期 + `replaces` + 默认列表 | **已实现**（`d4765ab` task-377；`9c71611`/`ea6dcb8` 补列表与筛选） | 默认 `time_horizon ... DEFAULT 'long_term'` `sqlite-store.ts:858-859`；`replaces` `REPLACES_JSON_COLUMN_SQL` `:869`/`:870`、入参 `tools.ts:331-335`；列表（`query` 变可选）`:1507-1520`、筛选 `timeHorizon` | 不传该字段 ⇒ `timeHorizon = long_term`；`searchDecisions(pid,{})` 返回 2 条（无需关键词）；`{timeHorizon:"temporary"}` 只返回临时那条；新建带 `replaces:[2]` ⇒ `get` 返回 `[2]`，旧条未被修改 |

**§1 #1 的 NULL 语义（卡面要求「显式决定并写进卡面」）** —— 现状已成事实，且是**允许**：

> **未传 `external_id` 的记录允许多条**（唯一索引把 NULL 视为互不相等）。决策已由 `d4765ab` 落地并在工具描述里明说：`CREATE_BATCH_DESCRIPTION`（`tools.ts:408-410`）「Rows without externalId are not deduplicated — do not re-submit them blindly.」实测：连建 5 条不带键的记录 ⇒ `external_id IS NULL` 行数 7（含前序），无报错。

### 1.2 `external_id` 行为契约（2026-11-14 task-600 收口）

四条**已落地的语义**，读代码时不要按常识补：

| 语义 | 行为 | 锚点 |
| --- | --- | --- |
| **不规范化** | 键**按原样存**：不 trim、不折叠大小写、不补零。`D-1120` / `d-1120` / `D-01120` 是**三个不同的键**（各建一行、互不去重）。 | `parseExternalId` `sqlite-store.ts:261-284` |
| **拒绝首尾空白** | 含首尾空白的键 ⇒ `VALIDATION_FAILED / field: externalId`，消息点名 whitespace。**不做静默 trim** —— trim 会把两个不同输入折成同一身份（零强制转换纪律）。批内同规则，整批回滚。 | 同上；校验函数 `startsOrEndsWithContractWhitespace` |
| **不做规范化是有意的** | 键是本工作区的**工作项号**（`D-1120` / `BL-584`），由人/脚本给出；折叠大小写或补零等于替调用方猜身份。宁可拒，不可猜。 | 同上 |
| **NULL 允许多条** | 未传 `external_id` 的记录**不受唯一约束**（SQLite 唯一索引视 NULL 互不相等）⇒ 可多条；批内不去重。已写进工具描述 `tools.ts:408-410`。 | `uq_decisions_external_id` `sqlite-store.ts:884` |

**唯一性边界 = 整个 Profile 库（跨项目），且失败必须说出来。** 键是工作区工作项号，天然全局，因此唯一性不收窄到项目级；代价是「B 项目用 A 项目的键」时返回的是 A 的记录。**回执必须能区分这种命中**：跨项目命中带 `existingProjectId`（同项目命中不带该字段），因为返回的 `decisionId` 在 B 项目里 `getDecision` 读不到 —— 不带这个字段时回执看起来就是一次普通成功（task-600 ③）。

**已知限制（不支持先建后补键）**：`update`/patch **不能**设置 `externalId`（`patch.externalId` ⇒ `VALIDATION_FAILED / Unknown field`），即建记录时没带键，之后**无法补**。理由：唯一迁移路径 `scripts/migrate-ledger.mjs:336` 创建即带键，存量不受影响；把「补键」加进去属于新增能力（需要处理键冲突与修订语义），单独立卡，不在 2026-11-14 这批。

**残余（已知，不修）**：拒绝首尾空白发生在**输入边界**（`parseCreateExtensions` / 批内逐项），DB 层 CHECK 只保证「非全空白 + 1–200 码点 + 无 NUL」。要在 DB 层禁止首尾空白需要重建表（SQLite 不能 ALTER CHECK）⇒ 要 schema v3，代价与收益不成比例：写入面只有 `create`/`create_batch` 两个入口，都过同一个解析器。

**复算**：

```
cd A12-DSH-decision/packages/dsh-decision
node --test tests/storage/decision-ops.test.mjs tests/host/tools.test.mjs tests/storage/sqlite-store.test.mjs
```

读数：**88 / 88 绿**（三个受影响文件；含 `task-600 ①` 与 `task-600: the tool face …` 两条新夹具；整包 `pnpm test` 148 / 148 绿）。变异自证：删掉首尾空白校验 ⇒ 只红 `task-600 ①`；删掉 `existingProjectId` ⇒ 只红 `external_id uniqueness spans projects…`（报「cross-project hit names the owning project」）。

**复核口径**：本次 `[实测]` 用一次性探针（`.tmp/dsd-592/probe*.mjs`，不入 git，建系统临时库、用完即删），全部直连 `src/storage/sqlite-store.ts`（Node 24 类型剥离，零构建）。**复算命令**：

```
cd A12-DSH-decision/packages/dsh-decision
node --test tests/storage/decision-ops.test.mjs tests/storage/sqlite-store.test.mjs tests/host/tools.test.mjs
```

读数：**86 / 86 绿，exit 0**（含 5 条 `T377` 专项）。变异自证：把 `createDecision` 的外部键查重整段删掉 ⇒ 上述套件 **4 红**（`T377: decision_create dedupes…`、`create with externalId…`、`dedupe returns the existing record's current revision…`、`external_id uniqueness spans projects…`）⇒ 幂等键**有夹具看守**，不是只靠读数。

---

## 2. 历史口径：§1–§8 的 8 条（按卡面要求逐条四态）

> 每条末列用「→ 现行」注明它在文档 §10/§11 里的**去向**。四态取值：`已有` / `有实现无工具` / `完全不存在` / `判断为已作废`。

| # | 需求原文 | 现状 | 锚点 | 证据等级 | 实现顺序建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | `export` 子命令（P0）：确定性排序的 JSONL + Markdown 双格式，字段含 `refs[]` / `prev_revision` / `actor` 等，产物可 commit 进 git | **判断为已作废** | 需求侧：§10.1 撤回硬门槛；§11 明确「第一期不要做」清单含 `export` / `verify` / 哈希链 / `import` / 告警守护进程 / 多 Profile 合并 / `superseded_by`（该文 :143）。本仓侧同向：无 export 入口，`package.json` 无 `bin`、`exports` 仅 `./typert` 与 `./client/typert`（源码） | `[源码]` | 不做 → 现行：撤回 |
| 2 | `import`：半结构化 markdown → DB，dry-run 报告 + 幂等 + 可回滚（P0） | **判断为已作废** | 需求侧：§10.2「接受『只有 create』…**要可续跑，不要 dry-run**」；§11 把 `import` 列入第一期不做；需求方对价是自己先算 848 行迁移清单（该文 :146） | `[源码]` | 不做。**它的功能被 §1 #1 的 `external_id` 以更便宜的方式替代** → 现行：换成幂等键 |
| 3 | **决策落空告警（P0）**：`accepted` 且 `refs` 中不含 `task` 超过 N 天即报警；另 `accepted` 未挂任何 `refs` 也进同一告警 | **判断为已作废（作为 DSD 需求）+ 完全不存在（作为能力）** | 需求侧：§10.6「『决策落空告警』**我们先自己做**（`undispatched` 索引），不等工具」；§11「告警守护进程 第一期不要做」。本仓侧：无 `refs`、无 `accepted` 状态（状态只有 `effective` / `voided`，`sqlite-store.ts:348-349`）⇒ **告警的三个必要输入（结构化 refs、可判定的「已接受」、时间阈值）一个都不存在**，不只是「没写告警逻辑」；六工具与 4 张表均无对应物（实测） | `[源码]` + `[实测]` | 不做（需求方已收回）。**DSD 侧欠的是它的底层能力**，即现行 §1 #3 的反向查询 → 现行：拆成 `refs` + 反向索引 |
| 4 | `refs` 一等公民 + 交叉索引：`refs: [{type, id}]`，支持「查 refs 含 `BL-584` 的决策」与反向查询（P1） | **判断为已作废** | 需求侧：§10.3 需求方**自我更正「我把方向量反了」** —— D→BL 99 处是台账方向错、不是工具缺陷；改为「**用类型约束，不用查询功能**」，反查只剩一个用途（可达性计算）且「不需要暴露成查询 API」。本仓侧 `refs` 全树 0 命中（源码） | `[源码]` | 不做「交叉索引查询」；保留的是**约束**与**反向索引** → 现行：§1 #2 + §1 #3 |
| 5 | 状态机 `proposed / accepted / superseded / retired` + `superseded_by` 必填且双向可查（P1） | **判断为已作废** | 需求侧：§10.4「接受『没法鉴别伪造者』…换成 `replaces` 写在新条上」；§10.5「`有效 / 废弃` 两态接受」；§11 把 `superseded_by` 列入不做。本仓侧：状态两态 `effective` / `voided`（`:348-349`）+ `void_reason` / `voided_at` 强制成对（`:355-358`）（源码），与 §10.5 一致 | `[源码]` | 四态状态机不做；`replaces` 见 §1 #4 → 现行：改成 `replaces` |
| 6 | 时间状语必须字段化：`revisit_when` / `defer_until` / `blocked_by_reason` 为结构化字段；默认查询把「缓做」与「稳定」分开列出（P1） | **前半 完全不存在 / 后半 已有但不达标** | 三个字段名在 schema 与入参里**均无**（源码）。近似物：`review_date`（`:347`）语义是「复核日期」，不是「满足什么条件再议」；`time_horizon`（`:344`）才是「缓做 vs 稳定」的轴。需求方 §10.5 已收窄为「字段名以你们 PLAN 为准，只需**默认列表能分开**」⇒ 收窄后的问题与 §1 #4 完全相同 | `[源码]` + `[实测]` | 不做三字段（需求方已收窄）；判据落在「默认列表」上 → 现行：并入 §1 #4 |
| 7 | `project_key` 映射（20+ 子项目）+ `export --all-profiles` 跨 Profile 合并（P1） | **前半 已有 / 后半 判断为已作废** | 前半：`projects(id, project_key, name, created_at, updated_at)`，唯一键即 `project_key`（`:298-318`），`createProject` 入参 `{name, projectKey}`（源码）。后半：§11 把「多 Profile 合并」列入第一期不做 | `[源码]` | 映射已有；合并不做。**残留风险已登记**：per-Profile 隔离 ⇒ 跨 Profile 无法判断一条决策属于谁（需求方 §7 原文），本仓不解决 |
| 8 | 「明确不要的」：不为文本可读改存储层；不建平行第二套记录系统 | **已有（约束已遵守）** | 存储层仍是插件自有 SQLite + `node:sqlite`（`sqlite-store.ts` 全文件，无第二存储后端）；无第二套记录系统（源码） | `[源码]` | 这是**约束条不是能力条**，不排期。**本仓侧的等价判据**：任何新需求都不得引入第二个写入口 |

---

## 3. `task-329` 已核三条：重核结果（附锚点）

| 项 | task-329 的说法 | 本次重核 | 锚点 | 证据等级 |
| --- | --- | --- | --- | --- |
| `getDecisionHistory` | 接口里有实现、没有任何工具暴露 | **成立** | 声明 `host/tools.ts:125`（`DecisionToolStore`）、实现 `storage/sqlite-store.ts:870`、六工具清单 `tools.ts:44-51` 无对应工具（源码）。**实测**：一次 `update` 后 `getDecisionHistory(projectId, decisionId)` 返回 1 条，键为 `revisionId` / `decisionId` / `changeKind` / `snapshot` / `createdAt`，`snapshot` 是完整旧记录 | `[源码]` + `[实测]` |
| `refs` | 六工具里根本不存在 | **成立，且比说法更彻底**：不是「没有工具」，是**没有这个概念的任何一个字**（无列、无表、无入参，传了被拒） | `src/` 全树 0 命中（源码）；`PRAGMA table_info` 15 列（实测） | `[源码]` + `[实测]` |
| `export` | 六工具里根本不存在；`package.json` exports 只有两个 typert | **成立**，但措辞要收紧：那两个是**模块子路径**导出（`./typert`、`./client/typert`），不是「导出命令」；本仓连 `bin` 字段都没有 ⇒ 不是「导出的实现被漏了」，是**没有可执行入口** | `package.json`（`bin` 缺失、`exports` 两项）（源码） | `[源码]` |

**一条新发现（task-329 没提）**：`decision_revisions` 的 `change_kind` 只有 `update` / `void` 两种（`:372-373`，源码），**创建本身不落 revision**。所以即使把 `getDecisionHistory` 暴露成工具，也**只能看到每次改动前的快照**，看不到「这条记录被创建过几次」—— 对「可续跑」无帮助，但对 §1 #1 的幂等键设计是一个正向约束：幂等键应落在 `decisions` 表上，**不要指望靠历史表去重**。

---

## 4. 最该先做的一条（一句话判断）

> **`external_id` 幂等键。**

理由不是「它是第一条」，而是**它是唯一一条「不做就会永久产生新脏数据」的**：

- 本插件**没有物理删除**（`decision_void` 只作废、保留历史并强制要求原因，`tools.ts:409`）⇒ 重复写入的记录**删不掉**，会永久占 id 并出现在每次搜索结果里；
- `decision_create_batch` 一次 ≤100 条且「任一失败整批回滚」⇒ 848 行需要 9 批，**单批原子不覆盖批间中断**，重跑必然重复；
- 其余三条的失败都可事后修：方向写错可以改方向、查询缺了可以后补、默认列表缺了可以后补。**只有重复写入不可逆。**

---

## 5. 这张表的证据怎么复算

本次 `[实测]` 全部来自三个探针（跑在系统临时目录，用完即弃，**不触碰任何既有数据库**；脚本在 `.tmp/dsd-330/`，不入 git）：

```js
// 要点：直接 import 源码 .ts（Node 24 类型剥离，零构建），建临时库，再开只读连接读真实 schema
import { SQLiteDecisionStore } from '../../A12-DSH-decision/packages/dsh-decision/src/storage/sqlite-store.ts';
import { DECISION_TOOL_NAMES } from '../../A12-DSH-decision/packages/dsh-decision/src/host/tools.ts';
```

| 断言 | 复算方式 | 读数 |
| --- | --- | --- |
| 六工具无 refs / export / query | import `DECISION_TOOL_NAMES` 后打印 | 6 个名字，无上述三者 |
| `decisions` 表无 `external_id` / `refs` / `replaces` / `time_scope` | `PRAGMA table_info(decisions)` | 15 列，这四个都不在 |
| 库里只有 4 张表（无 refs 关联表） | `SELECT name FROM sqlite_master WHERE type='table'` | `decision_revisions` / `decisions` / `projects` / `session_projects` |
| 传 `externalId` / `refs` / `replaces` / `time_scope` 被**拒绝**而非忽略 | 逐条 `createDecision` 传未知字段 | 四条全是 `VALIDATION_FAILED / Unknown field`，`field` 指向传入名 |
| 默认 `time_horizon` 是 temporary（需求要默认长期） | 不传该字段 create 后 `getDecision` | `timeHorizon` = temporary |
| 无「默认列表」：`search` 的 `query` 必填 | `searchDecisions(pid, {})` | `VALIDATION_FAILED / Expected a string / field: query` |
| 搜索结果不含 `timeHorizon`，也不能按它筛 | `searchDecisions(pid, { query })` 与 `{ timeHorizon }` | 项键 = `decisionId` / `preview` / `status`；筛选被拒 `Unknown field` |
| `getDecisionHistory` 实现可用但无工具 | `update` 一次后调用 | 返回 1 条，含 `changeKind` 与 `snapshot` |

---

## 6. 本文件不做什么

- **不实现任何一条**（按卡面：实现另派卡）。
- **不改 `internal/A03-xihe/docs/dsd-decision-requirements.md`** —— 那是需求方的留档。本表若指出该文某条与实际不符，只在本表登记（§0 两处偏差即此类），**不回头改对方的文档**。
- **不替需求方判断需求价值**。本表只回答「在不在、在哪、多贵」，不回答「值不值得做」。
- **不给排序表**。卡面要的是一句判断（§4），不是工时排序。
