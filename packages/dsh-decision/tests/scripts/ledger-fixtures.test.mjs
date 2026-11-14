// task-492 / D-1337 落地：两种「静默丢弃」形态的**冻结夹具**回归。
//
// 为什么不用真台账做夹具：真台账是 append-only 活文档，用它就等于把
// 「写死总数」的假绿陷阱再挖一遍（2026-11-14 task-482 实证：同一台帐两份
// 快照差 7 条，任何固定总数都会过期）。这里用**合成台账 + 字面期望集**。
//
// 覆盖三种形态（各一份十几行的合成台账，见 ./fixtures/）：
//   A 多号粗体标题行  **D-902+903（…）**：一个粗体标题里写两个号，
//     必须展开成两条独立条目（task-491 病灶之一）。
//   B 附记不紧跟母条目 **D-911 附记（…）** 出现在别的条目之后，
//     必须「同号吸收」回 D-911 的正文，不得留在当时正打开的 D-912（task-491 病灶之二）。
//   C 附记夹在宿主正文中间 **D-931 附记（…）** 落在 D-932 的正文当中：
//     附记回 D-931，但 D-932 在附记**之后的**正文仍须留在 D-932
//     （2026-11-14 实证：6e812ff 把附记当成新条目边界，带走了宿主后文）。
//
// 红态：断言失败时消息直接点名「哪个号缺了 / 哪条正文跑到了谁那里」，
// 不给「断言存在」这种看不出差别的通过态。
//
// 复算（cwd = packages/dsh-decision）：
//   node --test tests/scripts/ledger-fixtures.test.mjs
// 改前红自证（把被测脚本换成修复前的版本，测试应红）：
//   git -C ../.. show 67da28d:packages/dsh-decision/scripts/migrate-ledger.mjs > ../../.tmp/xh/migrate-prefix.mjs
//   DSD_LEDGER_SCRIPT=../../.tmp/xh/migrate-prefix.mjs node --test tests/scripts/ledger-fixtures.test.mjs
// 注：脚本把 ONE_ROOT 写成「自身所在位置向上四级」，故本测试把脚本与 src
// 复制进临时根的同构目录树后再跑（复制的是源文件字节，不改一字）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "../..");
const ONE = resolve(PKG, "../../..");
const FIXTURES = join(HERE, "fixtures");
// 默认跑仓库里现行脚本；环境变量只为「改前红」自证留的旁路。
const SCRIPT = process.env.DSD_LEDGER_SCRIPT
  ? resolve(process.env.DSD_LEDGER_SCRIPT)
  : join(PKG, "scripts", "migrate-ledger.mjs");

/** 在临时根里搭出脚本期望的目录同构树，只把台账换成合成夹具。 */
function sandbox(t) {
  const base = join(ONE, ".tmp", "xh");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "dsd-fixtures-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "A12-DSH-decision", "packages", "dsh-decision");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  writeFileSync(join(pkg, "scripts", "migrate-ledger.mjs"), readFileSync(SCRIPT));
  cpSync(join(PKG, "src"), join(pkg, "src"), { recursive: true });
  // 临时根没有 package.json，补一个 type=module 消掉 Node 的 typeless 警告。
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  const docs = join(root, "internal", "A03-xihe", "docs");
  mkdirSync(join(docs, "archive"), { recursive: true });
  // 卷A 用合成占位（夹具只考台账主文件的形态，不复制卷A）；占位文件也放在 fixtures/
  // 里，让「夹具目录 = 喂给迁移脚本的全部输入」这件事在盘上可读，而不是藏在代码字符串里。
  writeFileSync(join(docs, "archive", "lead-decisions-2026-11-05-to-2026-11-08.md"), readFileSync(join(FIXTURES, "fixture-vola-placeholder.md")));
  return { root, pkg, docs };
}

/** 在沙盒树上跑一次全量迁移，返回 { ids, decisions }。 */
function migrate(t, fixtureFile) {
  const { root, pkg, docs } = sandbox(t);
  writeFileSync(join(docs, "lead-decisions-ledger.md"), readFileSync(join(FIXTURES, fixtureFile)));
  const db = join(root, "fixture.sqlite");
  const report = join(root, "report.json");
  execFileSync(process.execPath, [join(pkg, "scripts", "migrate-ledger.mjs"), "--database", db, "--report", report], {
    encoding: "utf8",
    cwd: pkg,
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(existsSync(report), "迁移未产出 report");
  const caliber = JSON.parse(readFileSync(report, "utf8")).caliber;
  const sqlite = new DatabaseSync(db, { readOnly: true });
  const decisions = new Map();
  try {
    for (const row of sqlite.prepare("SELECT external_id, decision_text FROM decisions").all()) {
      decisions.set(row.external_id, String(row.decision_text));
    }
  } finally {
    sqlite.close();
  }
  return { ids: [...caliber.externalIds].sort(), decisions, caliber };
}

/** 差集断言：失败时点名缺号/多号，而不是只说「不相等」。 */
function assertSameIds(actual, expected, label) {
  const missing = expected.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !expected.includes(id));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    label + "：条目集合不符 — 缺 " + JSON.stringify(missing) + "，多 " + JSON.stringify(extra),
  );
}

test("夹具A：多号粗体标题行 **D-902+903（…）** 必须展开成两条独立条目", (t) => {
  const { ids, decisions, caliber } = migrate(t, "fixture-a-multi-number.md");
  // 期望差集参照（字面）：901 heading / 902+903 双号粗体 / 904 单号粗体 / 905 项目符号 / 906 表格行
  assertSameIds(ids, ["D-901", "D-902", "D-903", "D-904", "D-905", "D-906"], "夹具A");
  assert.ok(decisions.has("D-902"), "夹具A：D-902 未成为独立条目（多号未展开）");
  assert.ok(decisions.has("D-903"), "夹具A：D-903 未成为独立条目（多号未展开）");
  // 反向断言：母条目不得吞掉多号行（这是 67da28d 的红态）
  assert.ok(
    !decisions.get("D-901").includes("D-902+903"),
    "夹具A：D-901 正文里出现了 **D-902+903（…）** 整行 —— 多号粗体行被当成正文吞掉了",
  );
  assert.equal(caliber.parseFailed.length, 0, "夹具A：不应有解析失败");
});

test("夹具B：**D-911 附记（…）** 不紧跟母条目也必须归到 D-911 正文", (t) => {
  const { ids, decisions, caliber } = migrate(t, "fixture-b-adjunct.md");
  assertSameIds(ids, ["D-911", "D-912", "D-913"], "夹具B");
  const marker = "ADJUNCT-MARKER-911";
  assert.ok(decisions.get("D-911").includes(marker), "夹具B：附记正文没进 D-911（同号吸收未生效）");
  // 反向断言：附记不得留在「当时正打开的那条」——这是 67da28d 的红态
  assert.ok(
    !decisions.get("D-912").includes(marker),
    "夹具B：附记正文留在了 D-912 —— 同号吸收按「current」判，被别的条目插开就跑错父",
  );
  assert.equal(caliber.parseFailed.length, 0, "夹具B：不应有解析失败");
});

test("夹具C：附记夹在宿主条目正文中间，不得把宿主后续正文带走", (t) => {
  const { ids, decisions, caliber } = migrate(t, "fixture-c-adjunct-inside.md");
  assertSameIds(ids, ["D-931", "D-932", "D-933"], "夹具C");
  const marker = "ADJUNCT-MARKER-931";
  // 正向：附记回自己的号
  assert.ok(decisions.get("D-931").includes(marker), "夹具C：附记正文没进 D-931（同号吸收未生效）");
  // 反向（本轮真缺陷面）：附记是「侧插」，不得改变「当时打开的是哪条」——
  // 宿主条目 D-932 在附记之后的正文仍须留在 D-932。
  assert.ok(
    decisions.get("D-932").includes("B 的第二段"),
    "夹具C：D-932 附记之后的正文被带走了（附记把它后面的行一起算进 D-931）",
  );
  assert.ok(
    !decisions.get("D-931").includes("B 的第二段"),
    "夹具C：D-931 正文里出现了 D-932 的后续段落 —— 附记被当成新条目边界，吞了宿主的后文",
  );
  assert.equal(caliber.parseFailed.length, 0, "夹具C：不应有解析失败");
});
