# Host Config 路径契约（补充条款）

> **不是 SSOT。** 契约 SSOT = `plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md`
> （§1「约束与索引」第 70 行：每个 Profile 独立 SQLite DB；插件 Config 必须提供非空绝对路径 `databasePath`）。
>
> **本文件存在的理由**：SSOT 只写了「必须有非空绝对路径」这一条，而实现里另外三条
> （无默认值 / 不回落 / 不创建父目录）**只由 `packages/dsh-decision/src/host/config.ts:12-16` 的注释承载**，
> SSOT 未收录 ⇒ 改契约时无从下手。本文件把这四条**补齐为可 diff 的对象**，内容逐字取自该注释，未加新规则。

## §1 路径条款

| # | 规则 | 出处 | 违反时 |
| --- | --- | --- | --- |
| 1.1 | 每个 Profile **恰好一条**显式路径 `databasePath` | SSOT 第 70 行 | 缺失 ⇒ 拒绝加载 |
| 1.2 | 必须**非空** | SSOT 第 70 行 | 空串 ⇒ 拒绝 |
| 1.3 | 必须**绝对**（Windows 带盘符） | SSOT 第 70 行 + `config.ts` 注释 | 相对路径 ⇒ 拒绝 |
| 1.4 | 必须是 **SQLite 文件**路径 | `config.ts` 注释 | `:memory:`、已存在目录 ⇒ 拒绝 |
| 1.5 | 未配置时默认 **`<profile 目录>/decision.sqlite`**；该默认值由**包 `cordis.patch.yml` 的 `config.databasePath`** 提供（非插件代码推导），用户可在 profile 层覆盖。`ctx.baseUrl` 缺失 ⇒ 表达式返回 `undefined` ⇒ 按「缺 `databasePath`」报可操作错误。**插件代码仍无任何回落**（不得用 `$DSH_HOME` / `process.cwd()`） | `task-157` / `D-1523`；实现见 `cordis.patch.yml` | 代码里出现回落即违约；patch 层表达式必须全函数/无 I/O/不抛 |
| 1.6 | 插件**从不创建父目录** | `config.ts:12-16`（SSOT 未收录） | 父目录不存在 ⇒ 报错，由用户创建 |
| 1.7 | 不得指向插件包内或 `node_modules` 内 | `config.ts` + `assertOutsidePackage` | 拒绝 |

**校验顺序**（派生自 `resolveDatabasePath` 既有实现，非新规则）：Schemastery schema（1.1–1.2）→ 存储闸门（1.3–1.4）→ 目标形态（1.4 的「不是已存在目录」）→ 包内 / `node_modules` 排除（1.7）。任何一步失败抛 `TypeError`，调用方不得继续。

## §2 明确不收录的内容

`task-155` 起草的「未配置时默认落在 profile 数据目录」草案**不在本文件内**：其前提是可靠的 profile 目录事实源。**截至 2026-11-15 未在启动配置键（`ctx.webStartup` / `ctx.headlessStartup` / `ctx.myAppStartup`）之外证实该事实源**：`[实测]` pnpm `file:` 安装为 junction 进 `.pnpm` 虚拟库、desktop profile 为 dev-linked 符号链接；`[源码]` 无 profile 目录 env。

**`ctx.loader` 暴露面待枚举**（`task-157`）：`!!js` 的求值作用域是 `interpolate(fiber.ctx, config)` 传入的 **cordis `Context`**，因此 `ctx.loader` 等 service 均可达；其中 `ctx.baseUrl` 是「配置树锚点 / 插件包解析基准」（loader 在 `baseUrl` 未设时直接抛错），**候选事实源**，但其取值是否等于 profile 目录尚未证实。**证实前 1.5 不松动。**

## §3 修改要求

1. 改 1.1–1.4 ⇒ 同批更新 SSOT（PLAN-0769 spec）与本文件；改 1.5–1.7 ⇒ 同批更新 `config.ts:12-16` 注释与本文件；
2. 任何一条变更必须同步 `packages/dsh-decision/tests/host/config.test.mjs` 对应用例（拒绝类用例不得减少）；
3. 不得为「顺手能跑」放宽 1.5 / 1.6 —— 它们保护的是用户数据落在哪。
