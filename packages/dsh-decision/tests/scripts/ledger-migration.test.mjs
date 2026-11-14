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
  // 台账是活文档：解析失败不钉死 0，钉「每个失败都有结构化原因且不进候选」
  // （实测 2026-11-14 09:2x：D-1247 单条正文 210,903 码点超冻结 20,000 上限
  //  ⇒ 进人工队列是 fail-closed 的正确行为，不是回归）。
  const strictFailed = strict.caliber.parseFailed.map((f) => f.externalId).sort();
  const extFailed = ext.caliber.parseFailed.map((f) => f.externalId).sort();
  assert.deepEqual(strictFailed, extFailed, "两个口径的失败集一致（同一批条目）");
  for (const f of ext.caliber.parseFailed) {
    assert.ok(Array.isArray(f.reasons) && f.reasons.length > 0, f.externalId + " 有结构化失败原因");
    assert.ok(!ext.caliber.externalIds.includes(f.externalId), f.externalId + " 未进候选集（fail-closed）");
    assert.ok(f.reasons.every((r) => typeof r === "string" && r.length > 0), f.externalId + " 原因非空");
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
