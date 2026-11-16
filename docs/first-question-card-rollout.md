# 首次「选项目」卡片：生效步骤与验证（task-14）

本文只讲**怎么让 A1/A2 在运行实例里生效**、**怎么验证**、**怎么回退**。设计取舍见 DSD 里的 D-1743 与 task-14 卡面。

## 改了什么

| 档位 | 用户可感知的变化 | 旧行为（缺陷） |
|---|---|---|
| **A1 · 跳过** | 卡片被关掉时，返回专门的文案并说明「重新调用 + 用名称·key 选或新建」 | 误报 `Select exactly one project option.`（把「跳过」当成菜单错，用户看不出下一步） |
| **A1 · 键入** | 卡片里手打「名称 · key」、`projectKey`、或唯一的项目名，都能绑定；重名/前缀/乱写一律拒绝 | 手打内容被整体忽略 ⇒ 同样报菜单错 |
| **A2 · 首问窗口** | 首次选项目卡片最长等 120 s（可配），超时返回 `PROJECT_REQUIRED` 且**零写入** | 阻塞型 `ask()` 无超时，卡片没人理就一直挂着（当初「9–45 s 延迟」的真相是人在等卡） |

两张卡片都不改 schema、不写数据；超时/跳过路径的写入条数为 0（契约 §2 line 80）。

## 生效前置

- 代码已构建：`packages/dsh-decision/lib/host/first-binding.js`、`lib/host/config.js` 时间戳为 2026-11-16 20:07，内含新文案与 `DEFAULT_PROJECT_QUESTION_TIMEOUT_MS = 120_000`。
- **运行中的 DSH 仍持有旧 `lib/`**：插件在进程启动时从 `link:` 路径加载编译产物，改 `src/` 或 `lib/` 都不会热更新 ⇒ 必须重载/重启宿主。
- 数据面与本次改动无关：库内 1286 条迁移数据在重启前后一致（task-27 单独提交）。

## 生效步骤（需用户同意，执行前确认没有在跑的 UI 自审/长任务）

1. 确认当前没有正在跑的长任务（重启会断开在跑的会话流）。
2. **完全退出** DSH 桌面应用：关闭所有窗口，再从托盘退出（只关窗可能只是最小化）。
3. 确认进程已退出：

   ```bash
   tasklist //FI "IMAGENAME eq DeepSeek Harness.exe"
   # 期望：INFO: No tasks are running which match the specified criteria.
   ```

4. 重新打开 DSH 桌面应用，等 Web GUI 起来。
5. **不需要** `pnpm install`、不需要再 build。只有在你又改了 `src/` 时才需要：

   ```bash
   pnpm -C packages/dsh-decision run build
   ```

## 静态自检（不必重启，先确认包是新的）

```bash
cd packages/dsh-decision
grep -c 'answered without a selection' lib/host/first-binding.js   # 期望 2
grep -o 'DEFAULT_PROJECT_QUESTION_TIMEOUT_MS = [0-9_]*' lib/host/config.js  # 期望 DEFAULT_PROJECT_QUESTION_TIMEOUT_MS = 120_000
```

## 运行实例验证（重启后，在**新开的会话**里做）

> 三个用例都会让新会话经历「首次选项目」。①会产生一行 `session_projects` 绑定（该会话 → `xh`），无害且按会话幂等；②③ 零写入。

### ① 键入式回答（A1，约 10 s）

1. 新会话让 agent 调 `decision_search({ limit: 1 })`，出现「选项目」卡片。
2. 不点选项，在卡片的自定义输入里键入 `xh`（或 `XH · xh`）提交。
3. **期望**：工具直接返回结果页（绑定成功）。
4. 旧行为对照：`PROJECT_REQUIRED` + `Select exactly one project option.`

### ② 卡片被跳过（A1，约 10 s）

1. 另一个新会话，`decision_search({ limit: 1 })` → 卡片出现。
2. 直接关掉卡片（不选、不填）。
3. **期望**错误：

   ```
   PROJECT_REQUIRED
   The project question was answered without a selection, so nothing was written.
   Call the tool again and pick a project by its 名称 · key label, or pick 新建项目 to create one.
   ```

4. 旧行为对照：`Select exactly one project option.`
5. 零写入核对（绑定行数在 ② 前后相同）：

   ```bash
   node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DSH_HOME+"/profiles/desktop/decision.sqlite",{readOnly:true});console.log(db.prepare("select count(*) n from session_projects").get())'
   ```

### ③ 首问窗口超时（A2，约 2 min）

1. 第三个新会话，`decision_search({ limit: 1 })` → 卡片出现。
2. **什么都别点**，等 120 s（缺省窗口）。
3. **期望**：卡片关闭，工具返回 `PROJECT_REQUIRED` + `The user did not answer in time; nothing was written.`
4. 旧行为对照：无限等待（没有超时分支）。
5. 想缩短验证时间：在 profile 的 `cordis.patch.yml` 覆盖

   ```yaml
   - id: dsh-decision
     config: { projectQuestionTimeoutMs: 15000 }
   ```

   再重启。非法值（`0`、负数、小数、超过 2147483647）会在插件加载时直接报错（fail-closed，不会悄悄退化成「无超时」）。

## 判定表

| 用例 | 关键字符串（新） | 关键字符串（旧，出现即未生效） |
|---|---|---|
| ① 键入 `xh` | 直接返回结果，无错误 | `Select exactly one project option.` |
| ② 跳过卡片 | `answered without a selection` | `Select exactly one project option.` |
| ③ 晾 120 s | `did not answer in time` | 一直等你（无返回） |

## 回退

- 行为回退：`git -C <A12 仓> revert <A1/A2 的提交>` → `pnpm -C packages/dsh-decision run build` → 重启 DSH。
- 数据面无需回退：A1/A2 不动 schema；唯一新增数据是 task-27 迁移的 1286 条（独立提交，已对账 16/16）。
- 「想暂时关掉窗口」：没有关闭语义（`0` 非法），把 `projectQuestionTimeoutMs` 设成极大值（如 `2147483647` ms ≈ 24.8 天）等价于不设窗。

## 已知限制

- 键入匹配**不做**前缀/大小写折叠：`Atla`、`bore` 会被拒（宁可让用户重打，也不绑到错项目）；只有「名称 · key」标签、`projectKey`、或**唯一**项目名会被接受，重名走多义拒绝文案。
- 「跳过」的判定依赖 Client 提交 `selected: []`；`selected: []` + 空白 `custom` 同样按跳过处理（已覆盖用例）。
