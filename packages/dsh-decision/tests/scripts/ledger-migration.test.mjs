// task-406 / D-1251 条件②：保真仪器绿常驻。
// 迁移脚本 + 对账仪器的常驻回归：严格 T1-e 子集可复算（条件①）、全量幂等双跑、
// 对账 16 项全绿（含跨条污染检测）。台账是活文档（append-only），断言只钉
// 关系不钉死数字；台账/仪器缺失（独立 checkout）时响亮跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "../..");
const ONE = resolve(PKG, "../../..");
const SCRIPT = join(PKG, "scripts", "migrate-ledger.mjs");
const LEDGER = join(ONE, "internal/A03-xihe/docs/lead-decisions-ledger.md");
const RECONCILE = join(ONE, "internal/A03-xihe/evidence/2026-11-14-dsd-ledger-migration/reconcile.mjs");
const SKIP = !existsSync(LEDGER) || !existsSync(RECONCILE) || !existsSync(SCRIPT);
const skipReason = "台账源或保真仪器不在本 checkout（workspace 耦合件）";

function run(args) {
  return execFileSync(process.execPath, args, { encoding: "utf8", cwd: PKG, timeout: 120000 });
}

function migrate(args, reportPath) {
  run([SCRIPT, ...args, "--report", reportPath]);
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

function scratch(t) {
  const base = join(ONE, ".tmp", "xh");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "dsd-migration-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("严格 T1-e 子集可复算且为扩展集真子集（D-1251 条件①）", { skip: SKIP ? skipReason : false }, (t) => {
  const dir = scratch(t);
  const strict = migrate(["--dry-run", "--strict"], join(dir, "strict.json"));
  const ext = migrate(["--dry-run"], join(dir, "ext.json"));
  // 台账是活文档：解析失败不钉死 0，钉「每个失败都有结构化原因且不进候选」。
  // （2026-11-14 09:2x 曾见 D-1247 单条 210,903 码点：根因是粗体条目行
  //  **D-xxxx（…）** 未作边界、近 141 条被折进上一条正文——task-480 已修
  //  边界；仍保留本断言防回归：任何超限条目必须带结构化原因进人工队列。）
  const strictFailed = strict.caliber.parseFailed.map((f) => f.externalId).sort();
  const extFailed = ext.caliber.parseFailed.map((f) => f.externalId).sort();
  // 严格口径是盘点器 T1-e 原正则（###/####+表格行，不含粗体边界）⇒ 其正文
  // 只可能更长，失败集是扩展集失败集的超集；扩展集失败必在严格集失败内。
  assert.deepEqual(extFailed.filter((id) => !strictFailed.includes(id)), [], "扩展集失败 ⊆ 严格集失败");
  for (const [label, r] of [["严格", strict], ["扩展", ext]]) {
    for (const f of r.caliber.parseFailed) {
      assert.ok(Array.isArray(f.reasons) && f.reasons.length > 0, label + " " + f.externalId + " 有结构化失败原因");
      assert.ok(!r.caliber.externalIds.includes(f.externalId), label + " " + f.externalId + " 未进候选集（fail-closed）");
      assert.ok(f.reasons.every((x) => typeof x === "string" && x.length > 0), label + " " + f.externalId + " 原因非空");
    }
  }
  // 候选数 = 条目数 − 解析失败数（uniqueEntries 含失败条目，parsedOk 才是可迁移者）。
  assert.equal(strict.caliber.parsedOk, strict.caliber.uniqueEntries - strict.caliber.parseFailed.length, "严格口径 parsedOk 自洽");
  assert.equal(ext.caliber.parsedOk, ext.caliber.uniqueEntries - ext.caliber.parseFailed.length, "扩展口径 parsedOk 自洽");
  assert.equal(strict.caliber.lineLevelT1e, ext.caliber.lineLevelT1e, "行级口径一致");
  assert.ok(strict.caliber.uniqueEntries > 0, "严格集非空（空扫不是通过）");
  assert.ok(strict.caliber.uniqueEntries < ext.caliber.uniqueEntries, "严格集是扩展集真子集");
  const E = new Set(ext.caliber.externalIds);
  const violations = strict.caliber.externalIds.filter((id) => !E.has(id));
  assert.deepEqual(violations, [], "严格集每个 externalId 都在扩展集");
});

test("全量迁移幂等双跑 + 保真对账全绿（D-1251 条件②）", { skip: SKIP ? skipReason : false }, (t) => {
  const dir = scratch(t);
  const db = join(dir, "decisions.sqlite");
  const run1 = migrate(["--database", db], join(dir, "run1.json"));
  assert.equal(run1.migration.refused.length, 0, "首跑零拒绝");
  assert.equal(run1.migration.created, run1.caliber.parsedOk, "首跑创建数 = 可解析条目数（失败者留在人工队列）");
  assert.equal(run1.migration.created + run1.caliber.parseFailed.length, run1.caliber.uniqueEntries, "创建 + 解析失败 = 全部条目（无静默丢弃）");
  assert.ok(run1.spotChecks.every((s) => s.ok), "查询面抽查全过");
  const run2 = migrate(["--database", db], join(dir, "run2.json"));
  assert.equal(run2.migration.created, 0, "重跑零新建（幂等）");
  assert.equal(run2.migration.alreadyExisted, run2.caliber.parsedOk, "重跑全量已存在");
  const reconRaw = run([RECONCILE, "--database", db, "--report", join(dir, "run1.json")]);
  const recon = JSON.parse(reconRaw);
  assert.equal(recon.failed, 0, "对账零失败: " + JSON.stringify(recon.checks.filter((c) => !c.ok)));
  assert.ok(recon.passed >= 16, "对账至少 16 项（含跨条污染检测）");
});

// task-480 / D-1383：粗体条目行 **D-xxxx（标题…）** 必须是解析边界。
// 三处账必须对得上：独立盘点（不 import 迁移脚本）== 迁移 uniqueEntries
// == 对账 created + manualQueue；关键条目各自独立且不超 20,000 码点。
function independentInventory() {
  const files = [join(ONE, "internal/A03-xihe/docs/lead-decisions-ledger.md"), join(ONE, "internal/A03-xihe/docs/archive/lead-decisions-2026-11-05-to-2026-11-08.md")];
  const byD = new Map();
  for (const file of files) {
    let cur = null;
    const flush = () => { if (cur) { for (const d of cur.dnums) if (!byD.has(d)) byD.set(d, cur.kind); cur = null; } };
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const h = line.match(/^#{2,4}\s+`?(D-\d+(?:\s*[\/、,，]\s*`?D-\d+)*)/);
      if (h) {
        const uniq = [...new Set([...h[1].matchAll(/D-(\d+)/g)].map((x) => Number(x[1])))];
        if (cur && cur.dnums.length === 1 && cur.dnums[0] === uniq[0]) continue; // 同号吸收
        flush(); cur = { dnums: uniq, kind: "heading" }; continue;
      }
      const b = line.match(/^-\s+\*\*D-(\d+)[｜|]?(.*?)\*\*[：:]?\s*(.*)$/);
      if (b) { flush(); cur = { dnums: [Number(b[1])], kind: "bullet" }; continue; }
      const bo = line.match(/^\*\*D-(\d+)（(.*?)\*\*(.*)$/);
      if (bo) {
        const d = Number(bo[1]);
        if (cur && cur.dnums.length === 1 && cur.dnums[0] === d) continue; // 同号补记吸收
        flush(); cur = { dnums: [d], kind: "bold" }; continue;
      }
      if (cur) {
        const boundary = /^#{2,4}\s+`?D-\d+/.test(line) || /^##\s+(?!.*`?D-\d)/.test(line) || (cur.kind === "bullet" && /^-\s/.test(line));
        if (boundary) flush(); else continue;
      }
      const r = line.match(/^\|\s*`?D-(\d+)`?\s*\|/);
      if (r) {
        const cells = line.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.length <= 6) continue; // 索引行/状态回写行不是条目
        const d = Number(r[1]);
        if (!byD.has(d)) byD.set(d, "row");
      }
    }
    flush();
  }
  return byD;
}

test("粗体条目行是边界且三处账对得上（task-480 / D-1383）", { skip: SKIP ? skipReason : false }, (t) => {
  const dir = scratch(t);
  const report = migrate(["--dry-run"], join(dir, "ext.json"));
  const inventory = independentInventory();
  const kindCounts = [...inventory.values()].reduce((acc, k) => { acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  assert.ok(kindCounts.bold > 0, "台账存在粗体式条目（边界生效）");
  assert.equal(inventory.size, report.caliber.uniqueEntries, "独立盘点去重数 == 迁移 uniqueEntries");
  assert.equal(report.caliber.entryKinds?.bold ?? 0, kindCounts.bold ?? 0, "粗体条目数与独立盘点一致");
  // 关键回归：D-1247 不再吞并后续粗体条目、各自独立且不超上限。
  const oversized = report.caliber.parseFailed.filter((f) => f.reasons.some((r) => /超 20000/.test(r)));
  for (const id of ["D-1247", "D-1248", "D-1250", "D-1374"]) {
    assert.ok(report.caliber.externalIds.includes(id), id + " 是候选条目（未被并入他条）");
    assert.ok(!oversized.some((f) => f.externalId === id), id + " 不超 20,000 码点");
  }
  // 对账两侧口径一致：created + 人工队列 == uniqueEntries。
  assert.equal(report.caliber.parsedOk + report.caliber.parseFailed.length, report.caliber.uniqueEntries, "parsedOk + parseFailed == uniqueEntries");
});

test("小批 recent-20 幂等双跑", { skip: SKIP ? skipReason : false }, (t) => {
  const dir = scratch(t);
  const db = join(dir, "recent20.sqlite");
  const run1 = migrate(["--database", db, "--recent", "20"], join(dir, "r1.json"));
  assert.equal(run1.migration.created, 20);
  assert.equal(run1.migration.refused.length, 0);
  const run2 = migrate(["--database", db, "--recent", "20"], join(dir, "r2.json"));
  assert.equal(run2.migration.created, 0);
  assert.equal(run2.migration.alreadyExisted, 20);
});
