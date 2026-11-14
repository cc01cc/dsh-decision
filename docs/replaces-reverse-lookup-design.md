# 取代关系反查（G3）设计记录

> **用途**：`task-615` 的**先设计**产物 —— 在动手前把四个问题答完：选型、v1 升级、唯一权威、索引。落地读数在 [`requirements-vs-tool-surface.md`](requirements-vs-tool-surface.md) §1.3。
> **日期**：2026-11-14 · **起点**：`task-609` 的 G3（「谁取代了它」没有查询面）· **现状基线**：schema v2、`replaces_json` 已落地（`task-377`）、自引用已拒（`task-614` `670c2bf2`）

---

## 1. 选型：关系表（采用） vs `decisions` 加「被取代」列（否决）

**采用**：新建 `decision_replaces(id, decision_id, replaced_id, created_at)`，`UNIQUE(decision_id, replaced_id)`，反向索引 `idx_decision_replaces_reverse(replaced_id, decision_id)`，`replaced_id` **不加外键**（前向引用合法，见 §2/G1）。

**否决**：在 `decisions` 上加一列（如 `superseded_by`），新条写入时回填旧行。三条理由，任何一条都足够：

| # | 否决理由 | 依据 |
| --- | --- | --- |
| 1 | **违反「旧条不改」**：需求原文与已落地语义都是「写在新条上，旧条不改」。回填旧行必须 UPDATE 旧行 —— 要么动 `updated_at`（改列表排序、破坏 append-only 的时间线），要么引入「不改时间的 UPDATE」特例（没有快照 = 不可追溯，而且会让「更新必有快照」这条不变量出现例外） | `requirements-vs-tool-surface.md` §1.3 #4 读数：旧条 `revision`/`status`/`updatedAt` 全不变、`decision_revisions` 0 行 |
| 2 | **前向引用无处回填**：`replaces:[99999]`（被取代的记录可能后到）在今天是被接受的声明；回填时旧行不存在 ⇒ 只能挂起补偿，等于在库里加一条待办队列 | G1（`task-609` 裁定：不修前向引用） |
| 3 | **一列装不下一对多**：一条新条可声明取代多条（`replaces:[1,2]`）；列只能放 JSON 数组 ⇒ 元素不可索引，反查仍要解析/扫表，等于没解决 | `parseReplacesInput` 上限 100 条 |

**采用方案的代价（不隐瞒）**：多一张表；写路径多一次双写（同一事务内，不是两次提交）；绕过 store 直接写 SQL 时投影会漂移 —— 与现有 CHECK 约束同级的已知边界。

## 2. v1 库自动升级与失败行为

| 项 | 方案 |
| --- | --- |
| 版本 | `SCHEMA_VERSION` 2 → **3** |
| 迁移链 | v1 → 「v1→v2」→「v2→v3」；v2 → 「v2→v3」。两级在**同一个事务**内做完，中途任一步失败 ⇒ `ROLLBACK`，`user_version` 保持进入前的值，库不被半升级 |
| 回填 | `INSERT INTO decision_replaces (decision_id, replaced_id, created_at) SELECT d.id, j.value, d.created_at FROM decisions d, json_each(d.replaces_json) j WHERE d.replaces_json IS NOT NULL AND json_valid(d.replaces_json)`。`created_at` 取**声明方自己的创建时间**，不是回填时刻 —— 避免把历史声明伪装成今天写的 |
| v1 库的读数 | 真实 v1 夹具里 `replaces_json` 列刚加进来时为 NULL ⇒ 回填 **0 行**，老行行为不变 |
| **失败行为** | **拒绝启动**（抛错），不降级、不「先跑旧 schema 以后再说」：与既有 `preflightSchema` / `assertSchemaShape` 的 fail-closed 口径一致（`task-609` 实测：缺一条必需索引就开库失败）。版本不认识（未来版本）或 v2/v3 形状不符合同样拒绝启动 |
| 前置校验 | v1 形状先用 `EXPECTED_TABLES_V1/EXPECTED_INDEXES_V1` 断言，形状不对**不 ALTER**；v2 形状用 v2 期望集断言后再迁移 |
| 夹具要求 | 迁移**必须**用真实 v1 夹具（`packages/dsh-decision/tests/storage/fixtures/v1-schema.sql`，7,761 B，来自 task-377 之前的真 store）+ 一个**带 `replaces` 的 v2 库**（验证回填非 0 行），不接受「只测全新库」 |

## 3. 唯一权威 = 声明方（`decisions.replaces_json`）

**权威是 `replaces_json`**，`decision_replaces` 是它的**派生投影**。判据与边界：

1. `replaces` 是**输入原样声明**：建时给、之后不可改（G4），append-only 语义与快照形状都建在它上面 ⇒ 它必须是权威，否则「声明」与「派生」谁对谁错无法判定。
2. `decision_replaces` **只服务反向过滤**（`replacedDecisionId`），`decision_get` 的 `replaces` 仍从 `replaces_json` 读 —— 读面不依赖投影，投影坏了不会改答案。
3. **同一事务双写** ⇒ 正常路径不会漂移；测试里加一条一致性断言（建完后投影与 JSON 逐条相等）。
4. **漂移只能单向重算**：以 `replaces_json` 重算投影；**禁止**反向回写（拿投影去补 JSON）。两向互相校正会产出一个没有定义的合并语义，也是「第二真相源」的入口。
5. 直写 SQL（绕过 store）会漂移 ⇒ 与 CHECK 约束同级：store 是唯一写入口，这也是 `assertSchemaShape` 存在的前提。

## 4. 反向查询的索引与期望计划

```sql
-- searchDecisions(projectId, { replacedDecisionId: X })
WHERE project_id = ?
  AND id IN (SELECT decision_id FROM decision_replaces WHERE replaced_id = ?)
```

- 走 `idx_decision_replaces_reverse(replaced_id, decision_id)`；期望 `EXPLAIN QUERY PLAN`：
  `SEARCH decision_replaces USING COVERING INDEX idx_decision_replaces_reverse (replaced_id=?)`
  —— **COVERING** 是关键：子查询只取 `decision_id`，索引里有，不需要回表。
- 正向 `UNIQUE(decision_id, replaced_id)` 只用于「同一条决策不重复声明同一目标」和一致性核对，不服务反查。
- 会被调试的两种坏计划：`SCAN decision_replaces`（索引丢了／被改名）与 `SCAN decisions`（把反查写成 `json_each` 子查询）。夹具里直接断言计划文本里出现索引名且没有 SCAN。

## 5. 查询面（落地口径）

| 面 | 变更 |
| --- | --- |
| `decision_search` 入参 | 新增 `replacedDecisionId`（正整数，可选）：答「谁取代了 X」；与 `query`/`timeHorizon`/`refType+refId`/分页可组合 |
| `decision_search` 结果项 | 新增 `replaces`（`number[] \| null`，来自 `replaces_json`，不是投影）：列表即可看到「这条取代了谁」 |
| `decision_get` | 不变（`replaces` 一直有） |
| 老面 | 不变：`update` 仍改不了 `replaces`/`externalId`（G4），`refs` 面不动 |

## 6. 落地读数（`task-615` 实现后实测）

| 项 | 读数 |
| --- | --- |
| schema | `user_version` 2 → **3**；新库 6 张表、9 条命名索引 |
| 真实 v1 夹具升级 | v1（4 表）⇒ 一次事务升到 v3（6 表）；回填 **0 行**（v1 行没有 `replaces_json`）；老行 1 条不动 |
| v2 库升级回填（夹具口径） | 造一个 v2 库（v3 建库后剥掉 v3 新增的表/索引并回滚版本号，迁移是纯增量所以形状等价）⇒ 回填 **2 行**，`created_at` 与声明方自己的 `createdAt` 相同；反查立即命中 |
| v2 库升级回填（**真文件**交叉验证，不入 CI） | 用 `git show 670c2bf2:packages/dsh-decision/src/storage/sqlite-store.ts` 取**v3 之前的 store 代码**建库并写入 `replaces:[1,2]`（该文件 `user_version=2`、5 张表、`replaces_json='[1,2]'`）⇒ 用新 store 打开：升到 3、6 张表、回填 2 行且 `created_at` = 声明方 `2026-11-14T07:48:03.232Z`（不是升级时刻）、反查命中、`get` 仍返回 `[1,2]`。临时库在 `.tmp/dsd-615/`，用完即弃 |
| 反向查询 | `{replacedDecisionId: X}` ⇒ 命中声明方；未命中 ⇒ `[]`（不是报错）；非法值 ⇒ `field: replacedDecisionId` |
| 访问路径 | `SEARCH decision_replaces USING COVERING INDEX idx_decision_replaces_reverse (replaced_id=?)` |
| 一致性 | 正常写路径下 `decision_replaces` 与 `replaces_json` 逐对相等（夹具里断言） |
| 变异 | 去掉投影写入 ⇒ 3 红；去掉反向过滤 ⇒ 4 红；索引改成非覆盖 ⇒ 只红 `task-615` 存储夹具；回填写「今天」⇒ 只红回填夹具 |

## 7. 判定为「不做」的相邻问题

- **不做**「取代链解析」（A 取代 B、B 取代 C ⇒ 只答 A 取代 C）：需求只问「谁取代了它」，链式闭包是另一个语义（还涉及环检测）。
- **不做** 自动作废被取代的记录：需求明确「旧条不改」，且 void 有独立语义。
- **不做** `decision_replaces` 的外键（`replaced_id`）：会禁掉 G1 的前向引用。
