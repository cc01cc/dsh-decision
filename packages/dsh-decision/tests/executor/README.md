# tests/executor — 真实 DSH 执行器矩阵（PLAN-0779 T2.4）

这里不是桩测。`tests/host/tools.test.mjs` 用本地 stand-in 直接 `tool.execute()`，
从不经过注册与分派；本目录把六个工具挂到**生产执行器栈**上跑模型形态的调用：

```
cordis Context
  + @deepseek-ai/dsh-system-prompt   (ToolsService 构造依赖)
  + @deepseek-ai/dsh-tools           ToolsService.register / execute
  + @deepseek-ai/dsh-tool-executor-native   ToolExecutionPipeline + executeToolBatch
```

调用形态与真实 Host 一致：`arguments` 是 **JSON 字符串**、批量分派、带 `AbortSignal`；
返回 `{isError, value, error, content}`。因此本目录能看到桩测看不到的三件事：
registry 级参数校验（`ToolArgsError` ⇒ `isError` 结果）、**输出 schema 校验**
（`ToolOutputError`）、以及注册面本身的合法性。

## 跑法

```bash
# 1) 备 host（一次性；见下）
node tests/executor/extract-host.mjs --dsh-root <DSH checkout 根>
# 2) 跑矩阵（cwd = packages/dsh-decision）
node --test tests/executor/executor-matrix.test.mjs
```

host 解析顺序：`DSD_EXECUTOR_HOST`（指向含 `node_modules/` 的目录）→ 默认
`<one>/.tmp/xh/dsd-executor-host`。**找不到 host 时全部用例大声 skip**，
skip 理由里带恢复命令 —— 缺 host 绝不读成绿矩阵。

## 为什么要抽 host

安装版 DSH 把这些包放在 Electron asar 归档里，plain node 读不到；而本矩阵必须在
plain node 下可复算。`extract-host.mjs` 把执行器真正 import 的依赖闭包（15 包）
拷成 plain-node 可读树，**不改任何项目 manifest、不装依赖**。
归档树只能在 fs 能读它的运行时里抽（DSH 的 Electron 运行时可以）；
脚本本身是纯 fs 读写，源路径从 argv/env 取，不写机器绝对路径。

2026-11-14 00:1x 本机实测读数（抽取仪器自报）：15 包 / 670 文件 / 5,078,099 B；
`dsh-tools@0.2.2-rc.1`、`cordis@4.1.0`、`schemastery@3.19.0`、`zod@4.4.3`。

## 注册面缺陷与修法（task-388 / D-1238，已裁 B，已修）

**缺陷**：`registerDecisionTools` 原先把 author-spec 定义直接交给 raw
`ToolsService.register()`。真实 registry 对 `output.schema` 跑
`assertSupportedJsonSchema`（原始 JSON Schema 子集），而 DSD 的 schema 是
**author-spec**（叶子 `required:true`）⇒ 六工具全部 `UNSUPPORTED_SCHEMA`，
在真实 Host 上一个都挂不上。桩测从不注册，所以这个缺陷一直隐身。

**修法（B）**：注册前用宿主提供的 `defineTool()` 编译。六工具 schema 一行不用改
（它们本来就是 `compilePropertyMap`/`compileValueSchema` 吃的 author-spec），
一处同治三面：注册面合法、模型面 parameters 变成合法 JSON Schema、执行器级
参数校验（`ToolArgsError`/`INVALID_ARGS`）与输出校验（`ToolOutputError`）生效。

**结构约束**：`registerDecisionTools(sink, deps, compile)` 的 `compile` 是**必填**
第三参（fail-closed）。可选/默认 identity 会让「忘编译」静默退回缺陷路径。
`src/host/tools.ts` **不静态 import** `@deepseek-ai/dsh-tools`：npm 上 published
的是 `0.0.1-rc.1`，宿主运行时是 `0.2.2-rc.1`（`pnpm view` 实测），静态 import 会
装到错版本并炸掉全部 L0；编译器由接线面注入，package.json 只声明 **peerDependencies**。

**读数**（命令均为 `node --test tests/executor/executor-matrix.test.mjs`，cwd=`packages/dsh-decision`）：
- 修前：tests 8 / pass 0 / fail 8，exit 1，全部 `JsonSchemaError code=UNSUPPORTED_SCHEMA`（注册阶段）。
- **修后：tests 8 / pass 8 / fail 0 / skipped 0，exit 0**；140 断言 / 67 次真执行器调用。
- host 缺失：skipped 8 / pass 0，exit 0 —— **skip 不是绿**，看 skipped 计数与 skip 理由。
- 同批 L0（`pnpm test`，9 文件）：120 / 120 绿，exit 0（签名改动无回归）。
- sha 与覆盖矩阵见 `plans/PLAN-0779-DSD-agent-tools/evidence/m2-t2.4-real-executor-matrix.md`。

## 两条边界事实（矩阵按此断言）

1. **未知字段拒绝分两层**：顶层 parameter map 编译成**开放**对象
   （`parameterSchemaSpecToJsonSchema` 不加 `additionalProperties:false`）⇒ 顶层未知
   字段进到工具体，由 DSD domain parser（`decision-contract.ts` 的 `unknownField`）
   拒，断言 `VALIDATION_FAILED` + `field`；而**嵌套对象**（batch item、update patch）
   自己声明了 `additionalProperties:false` ⇒ 真 registry 直接拦，断言
   `isError` + `error.info.code === "INVALID_ARGS"`。两层都在矩阵里钉住。
2. **caller 拒绝不是 domain envelope**：`DecisionToolRefusal` 是抛出的，真实执行器
   把它变成 `isError` 结果；矩阵断言它绝不冒充七个 domain code 之一。
