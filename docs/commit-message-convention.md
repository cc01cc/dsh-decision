# 提交信息规范（A12 / DSD）

> **状态**：生效（2026-11-15，`task-29`）· **执行面**：`scripts/check-commit-msg.mjs`（提交时由 `xh-commit` 守卫 ⑦ 自动调用）· **自测**：`scripts/check-commit-msg.test.mjs`
> **为什么有这个文件**：`xh-commit` 守卫 ⑦ 按**目标仓**解析门禁（`xh-commit.mjs:560` 的 `gatePathFor()` ⇒ `<repo>/scripts/check-commit-msg.mjs`）。本仓此前没有这个文件，守卫每次都打 `skip: 无消息门禁脚本` —— 35 笔提交**一笔都没被查过**（`task-24` 读数）。补上门禁后，非 0 退出即 `E_MSG_GATE`，ref 一个字节不动。

---

## 1. 门禁查什么（五条，最小集）

| # | 判据 | 处置 |
| --- | --- | --- |
| 1 | 首行显示宽度 **≤ 72 列**（CJK/全角记 2 列；merge 首行 ≤ 100） | ✗ 阻断 `E_SUBJECT_TOO_WIDE` |
| 2 | 首行 `<type>(<scope>): <摘要>`，type ∈ `feat\|fix\|docs\|test\|style\|chore`（本仓实测集合） | ✗ 阻断 `E_SUBJECT_FORMAT` / `E_BAD_TYPE` / `E_EMPTY_SUBJECT` |
| 3 | 首行或 body 出现引用 `task-NNN` / `PLAN-NNNN` / `BL-NNN` / `D-NNN` | · **只 warn** `W_NO_REF`（最近 20 笔里 4 笔无引用，拦了会挡真实工作） |
| 4 | 未知参数 | ✗ `exit 2`（fail-closed：认不出的参数**绝不**当通过） |
| 5 | 默认只校验 **HEAD 这一笔** | 不给 `--range` 就不会去翻历史 |

**历史不判红**：本仓历史有 2 笔超宽（`e0a1cbbc` 73 列、`d4765ab7` 85 列），属既成事实。用 `--range <root>..HEAD` 跑全历史**会红这 2 笔**，那是设计如此 —— 不要为了变绿改写历史。

**故意不做**（`task-24` A/B 的 B 方案）：body 行宽、emoji、空词、白名单文件、`--stats`、`--report-only`、流式 `git log`。A 方案（移植 A03 的 295 行门禁）多出来的全是 warn 类检查，本仓 20/20 本来就合规，却要多背两个得有人守的开关。

## 2. body 必须含「改动:」段（零代码的 ⑦′ 约定）

`xh-commit` 还有第二道只读对账（⑦′，`--msg-diff-check`）：把 body 里点名的路径与本次 diff 对账。它的段名白名单**写死在共享脚本里**（`xh-commit.mjs:1119/1160`），**本仓改不了**；段名一个都不在 change 组时，它**整门跳过**并只打 `WARN BODY_NO_CHANGE_SECTION` —— 那是「没查」，不是「查过且干净」。

**约定**：提交 body **必须含一个 `改动:` 段**（change 组：`改动/`变更/`修改/`What/`What changed` 都认）。`读数:`/`变异:`/`验证:` 照写（它们在 reference 组，是证据不是改动声明）。

**为什么不把「读数」塞进共享白名单**：`BODY_PATH_MISSING` 只认 change 组，而「读数」段里常点文件路径 ⇒ 塞进 change 组会把证据段当改动声明，造出假 WARN（`D-1074`：假红会把人逼去改措辞而不是改内容）。**实测 7/7 的跳过都只因「读数」一个段名**（`task-24`），所以最省事的修法是写 body 时多写一行 `改动:`。

## 3. 可抄的模板

```
feat(dsd): 落空告警反查参数 withoutRefType + withRefTypes（task-1）

改动: packages/dsh-decision/src/storage/sqlite-store.ts, packages/dsh-decision/src/host/tools.ts,
      packages/dsh-decision/tests/storage/decision-ops.test.mjs, docs/dispatch-gap-reverse-lookup-design.md
读数: 缺口 532 条（零改动清单 532，差 0）；默认 982 条 id 序列 firstDiffIndex=-1
变异: 去掉 NOT EXISTS ⇒ 3 红（D-899 反例转红）；refTypes 改回 SQL 序 ⇒ 1 红
不做: BL 侧两跳反查（另卡）
```

- 首行放**结论**，细节进 body；首行别超 72 列（约 36 个汉字，CJK 记 2 列）。
- `改动:` 段列**本次真改的路径**；只写概念/命令、不点任何文件时，⑦′ 会打 `SKIP` 而不是假装查过。

## 4. 怎么自查（三行命令）

```powershell
node scripts/check-commit-msg.mjs --file .git/COMMIT_EDITMSG   # 单笔（门禁就是这么被调用的）
node scripts/check-commit-msg.mjs --range HEAD~20..HEAD        # 最近 20 笔：当前读数 红 1 / warn 4
node --test scripts/check-commit-msg.test.mjs                  # 自测 8/8（含一条宽度变异）
```

**读数基线（2026-11-15，`c127af0`）**：最近 20 笔 ⇒ **红 1**（`e0a1cbbc` 73 列）/ warn 4；全历史 34 笔 ⇒ **红 2**（`e0a1cbbc` 73、`d4765ab7` 85）。自测 8/8；把列宽上限改成 200 ⇒ 73 列夹具立刻转绿（3 条断言红），证明宽度判据真的在跑。
