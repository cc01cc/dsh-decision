#!/usr/bin/env node
// 决策候选 → decision_create_batch 入参（task-40；task-26 结论 A+ 的落地件）。
//
// 为什么要这个脚本：委派 lane（subagent）在 caller gate 就被拒（DELEGATED_CALLER，
// 契约 plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md:78 的 Root-Agent-only
// 选择），所以 lane 只能「报告候选、root 落库」。本脚本把 lane 写的候选 JSON 校验并
// 转成 root 直接可用的 decision_create_batch 入参：**幂等键 = 提案 id = externalId**，
// 于是 root 重试 / lane 重发 / 批量中断续跑都不会重复建条。
//
// 只读 + 纯新增：不引用存储层实现（不 import 任何 storage/sqlite 模块）、不发网络请求、
// 不写库（卡面验收：对存储层关键字做 grep 必须 0 命中）。唯一的写是 --out/--report 指定
// 的文件，且只写 JSON。
//
// 用法（零依赖，Node 24+）：
//   node scripts/proposals-to-batch.mjs                     # 扫 one/.tmp/*/decision-proposals/*.json
//   node scripts/proposals-to-batch.mjs --dir <dir> [...]   # 扫给定目录（可重复）
//   node scripts/proposals-to-batch.mjs --out <path>        # 入参写文件（stdout 打报告）
//   node scripts/proposals-to-batch.mjs --report <path>     # 报告另存 JSON
//   node scripts/proposals-to-batch.mjs --selftest          # 内置自测（5 组用例）
//
// 退出码：0 = 全部候选合格（或有候选但无拒绝）；1 = 至少一条候选被拒（报告里逐条给理由）；
//         2 = 参数/IO 错误（读不到目录等）。被拒 ≠ 中断：合格条目照样进 batch，root 可先落合格批。
//
// 候选目录的硬约定（护栏，别让候选随 .tmp 蒸发）：
//   优先级 = internal/A03-xihe/evidence/<日期>-<主题>/decision-proposals/  >  one/.tmp/<lane>/decision-proposals/
//   重要候选（会被 root 异步落库、或跨会话传递）**必须**落前者；.tmp 只用于当轮临时交换。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** one/ 仓根：scripts → dsh-decision → packages → A12-DSH-decision → one */
const ONE_ROOT = resolve(HERE, "../../../..");
const DEFAULT_SCAN_ROOT = join(ONE_ROOT, ".tmp");
const PROPOSAL_DIR = "decision-proposals";
const REF_TYPES = ["decision", "task", "commit", "plan"];
const TIME_HORIZONS = ["long_term", "temporary"];
/** 已知字段：其余字段不报错（lane 可能带 impacts/verification 等自由段），但会进 warnings。 */
const KNOWN_KEYS = new Set([
  "id", "proposalId", "summary", "decision", "rationale", "timeHorizon", "decisionDate",
  "sourceReference", "refs", "replaces", "reviewDate", "lane", "impacts", "verification", "questionsForRoot", "note",
]);
const LIMITS = { id: 200, summary: 300, decision: 20000, rationale: 20000, sourceReference: 4000, refId: 200 };

function die(message, code = 2) {
  process.stderr.write("proposals-to-batch: " + message + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const args = { dirs: [], out: null, report: null, selftest: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selftest") args.selftest = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dir") {
      const v = argv[++i];
      if (!v) die("--dir 缺少路径");
      args.dirs.push(v);
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) die("--out 缺少路径");
      args.out = v;
    } else if (a === "--report") {
      const v = argv[++i];
      if (!v) die("--report 缺少路径");
      args.report = v;
    } else die("未知参数: " + a + "（--help 看用法）");
  }
  return args;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePoints(text) {
  return [...text].length;
}

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 提案 id 同时是 externalId：1–200 码点、不许任何空白、不许首尾空白（DSD 不做 trim）。 */
function checkProposalId(value, errors) {
  if (typeof value !== "string") { errors.push("id 必须是字符串"); return null; }
  if (/\s/u.test(value)) errors.push("id 不许含空白（它同时是 externalId，DSD 不 trim）");
  if (codePoints(value) < 1 || codePoints(value) > LIMITS.id) errors.push("id 长度须 1–" + LIMITS.id + " 码点");
  return value;
}

function checkText(value, field, limit, errors, required) {
  if (value === undefined || value === null) {
    if (required) errors.push(field + " 必填（可直接落库的完整句，不能留空）");
    return undefined;
  }
  if (typeof value !== "string") { errors.push(field + " 必须是字符串"); return undefined; }
  if (required && value.trim() === "") { errors.push(field + " 不许空白"); return undefined; }
  if (codePoints(value) > limit) errors.push(field + " 超过 " + limit + " 码点上限");
  return value;
}

function checkRefs(value, errors, warnings) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { errors.push("refs 必须是数组"); return undefined; }
  const refs = [];
  value.forEach((ref, index) => {
    const at = "refs[" + index + "]";
    if (!isPlainObject(ref)) { errors.push(at + " 必须是对象 {type,id}"); return; }
    const type = ref.type;
    const id = ref.id;
    if (!REF_TYPES.includes(type)) {
      errors.push(at + ".type 必须是 " + REF_TYPES.join("/") + " 之一（bl 不在其列：方向规则禁止 decision→bl）");
      return;
    }
    if (typeof id !== "string" || id.trim() === "") { errors.push(at + ".id 必须是非空字符串"); return; }
    if (id !== id.trim()) errors.push(at + ".id 不许首尾空白（DSD 原样存，不 trim）");
    if (codePoints(id) > LIMITS.refId) errors.push(at + ".id 超过 " + LIMITS.refId + " 码点上限");
    refs.push({ type, id });
  });
  const seen = new Set();
  for (const ref of refs) {
    const key = ref.type + "|" + ref.id;
    if (seen.has(key)) warnings.push("refs 有重复边 " + key + "（DSD 侧会去重，这里保留一条）");
    seen.add(key);
  }
  return refs.filter((ref, index) => refs.findIndex((r) => r.type === ref.type && r.id === ref.id) === index);
}

function checkReplaces(value, errors, warnings) {
  if (value === undefined) return { present: false, list: undefined };
  if (!Array.isArray(value)) { errors.push("replaces 必须是数字数组"); return { present: true, list: undefined }; }
  if (value.length === 0) {
    // 缺省 = 「不声明取代」；空数组语义相同但通常说明作者没填完 ⇒ 不报错，必须留警告。
    warnings.push("replaces 是空数组：与缺省等价（输出里省略该字段）；若本意是取代某条，请填 DSD 数字 id");
    return { present: true, list: undefined };
  }
  const list = [];
  value.forEach((n, index) => {
    if (!Number.isSafeInteger(n) || n <= 0) errors.push("replaces[" + index + "] 必须是正整数（DSD 的 decisionId）");
    else list.push(n);
  });
  return { present: true, list: [...new Set(list)] };
}

/** 单条候选 → { input, errors, warnings }。纯函数，不碰文件系统。 */
export function normalizeProposal(raw) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { input: null, errors: ["候选必须是 JSON 对象"], warnings };
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push("未知字段 " + key + "（已忽略，模板见 docs 节）");
  }
  const id = checkProposalId(raw.id ?? raw.proposalId, errors);
  const summary = checkText(raw.summary, "summary", LIMITS.summary, errors, false);
  const decision = checkText(raw.decision, "decision", LIMITS.decision, errors, true);
  const rationale = checkText(raw.rationale, "rationale", LIMITS.rationale, errors, false);
  const sourceReference = checkText(raw.sourceReference, "sourceReference", LIMITS.sourceReference, errors, false);
  // timeHorizon 一定显式输出：域解析层缺省值（temporary）与工具描述（long_term）不一致，
  // 省略会把口径交给下游，模板要求写死，故缺省补 long_term 并留警告。
  let timeHorizon;
  if (raw.timeHorizon === undefined) {
    timeHorizon = "long_term";
    warnings.push("timeHorizon 缺省，已按 long_term 补全（模板要求显式写）");
  } else if (!TIME_HORIZONS.includes(raw.timeHorizon)) {
    errors.push("timeHorizon 必须是 " + TIME_HORIZONS.join("/") + " 之一");
  } else timeHorizon = raw.timeHorizon;
  let decisionDate;
  if (raw.decisionDate === undefined) decisionDate = undefined;
  else if (typeof raw.decisionDate !== "string" || !isRealDate(raw.decisionDate)) {
    errors.push("decisionDate 必须是真实存在的 YYYY-MM-DD");
  } else decisionDate = raw.decisionDate;
  let reviewDate;
  if (raw.reviewDate === undefined) reviewDate = undefined;
  else if (typeof raw.reviewDate !== "string" || !isRealDate(raw.reviewDate)) {
    errors.push("reviewDate 必须是真实存在的 YYYY-MM-DD");
  } else reviewDate = raw.reviewDate;
  const refs = checkRefs(raw.refs, errors, warnings);
  const replaces = checkReplaces(raw.replaces, errors, warnings);
  if (errors.length > 0) return { input: null, errors, warnings };
  const input = { decision };
  if (summary !== undefined) input.summary = summary;
  if (rationale !== undefined) input.rationale = rationale;
  input.timeHorizon = timeHorizon;
  if (decisionDate !== undefined) input.decisionDate = decisionDate;
  if (sourceReference !== undefined) input.sourceReference = sourceReference;
  if (reviewDate !== undefined) input.reviewDate = reviewDate;
  if (refs !== undefined && refs.length > 0) input.refs = refs;
  if (replaces.list !== undefined) input.replaces = replaces.list;
  input.externalId = id;
  return { input, errors, warnings };
}

function listProposalFiles(dirs) {
  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      files.push({ dir, missing: true });
      continue;
    }
    const walk = (current) => {
      for (const name of readdirSync(current).sort()) {
        const abs = join(current, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith(".json")) files.push({ dir, file: abs });
      }
    };
    walk(dir);
  }
  return files;
}

function laneOf(file) {
  const parts = resolve(file).split(/[\\/]+/u);
  const at = parts.indexOf(PROPOSAL_DIR);
  return at > 0 ? parts[at - 1] : "unknown-lane";
}

/** 把若干「文件 + 原始 JSON」转成 batch 入参与报告。纯函数，供 main 与 selftest 共用。 */
export function buildBatch(entries) {
  const decisions = [];
  const report = { scanned: entries.length, accepted: 0, rejected: 0, warnings: 0, entries: [] };
  const seen = new Map();
  for (const entry of entries) {
    const line = { source: entry.source, lane: entry.lane, externalId: null, status: "accepted", errors: [], warnings: [] };
    let raw = entry.raw;
    if (typeof entry.text === "string") {
      try { raw = JSON.parse(entry.text); }
      catch (error) { line.errors.push("JSON 解析失败: " + String(error.message)); }
    }
    if (line.errors.length === 0) {
      const result = normalizeProposal(raw);
      line.errors.push(...result.errors);
      line.warnings.push(...result.warnings);
      if (result.input !== null) {
        const dup = seen.get(result.input.externalId);
        if (dup) line.errors.push("提案 id 在本次扫描里重复（另一份: " + dup + "）—— 幂等键重复会让后一条被当成已存在");
        else seen.set(result.input.externalId, entry.source);
        line.externalId = result.input.externalId;
        if (!dup) decisions.push(result.input);
      }
    } else {
      line.externalId = typeof entry.raw?.id === "string" ? entry.raw.id : null;
    }
    if (line.errors.length > 0) { line.status = "rejected"; report.rejected += 1; }
    else report.accepted += 1;
    report.warnings += line.warnings.length;
    report.entries.push(line);
  }
  return { batch: { decisions }, report };
}

function printReport(report, where) {
  where.write("proposals-to-batch: 扫描 " + report.scanned + " 份，合格 " + report.accepted + "，被拒 " + report.rejected + "，警告 " + report.warnings + "\n");
  for (const line of report.entries) {
    if (line.status === "accepted" && line.warnings.length === 0) continue;
    where.write("  [" + line.status + "] " + line.source + " => " + (line.externalId ?? "(no id)") + "\n");
    for (const error of line.errors) where.write("      ! " + error + "\n");
    for (const warning of line.warnings) where.write("      · " + warning + "\n");
  }
}

function writeMaybe(path, text) {
  if (!path) return;
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  process.stderr.write("proposals-to-batch: 已写 " + abs + "\n");
}

function defaultDirs() {
  const dirs = [];
  if (!existsSync(DEFAULT_SCAN_ROOT)) return dirs;
  for (const name of readdirSync(DEFAULT_SCAN_ROOT).sort()) {
    const candidate = join(DEFAULT_SCAN_ROOT, name, PROPOSAL_DIR);
    if (existsSync(candidate)) dirs.push(candidate);
  }
  return dirs;
}

function runMain(args) {
  const dirs = args.dirs.length > 0 ? args.dirs.map((d) => (isAbsolute(d) ? d : resolve(process.cwd(), d))) : defaultDirs();
  if (dirs.length === 0) {
    process.stderr.write("proposals-to-batch: 没有找到候选目录（默认扫 " + join(DEFAULT_SCAN_ROOT, "*", PROPOSAL_DIR) + "）\n");
    return 0;
  }
  const scanned = listProposalFiles(dirs);
  const missing = scanned.filter((entry) => entry.missing);
  for (const entry of missing) process.stderr.write("proposals-to-batch: 目录不存在，跳过 " + entry.dir + "\n");
  const entries = scanned
    .filter((entry) => entry.file)
    .map((entry) => ({ source: entry.file, lane: laneOf(entry.file), text: readFileSync(entry.file, "utf8") }));
  const { batch, report } = buildBatch(entries);
  const payload = JSON.stringify(batch, null, 2) + "\n";
  if (args.out) { writeMaybe(args.out, payload); printReport(report, process.stderr); }
  else { process.stdout.write(payload); printReport(report, process.stderr); }
  writeMaybe(args.report, JSON.stringify(report, null, 2) + "\n");
  return report.rejected > 0 ? 1 : 0;
}

const CASES = [
  {
    name: "正常单条（模板全字段）",
    raw: {
      id: "dsd-1-20261116-001",
      summary: "提案落库走 externalId 幂等键",
      decision: "lane 的决策候选一律以提案 id 作为 externalId 落库，root 重试不得重复建条。",
      rationale: "task-27 实测重复跑 created 0 / alreadyExisted 1286。",
      timeHorizon: "long_term",
      decisionDate: "2026-11-16",
      sourceReference: "internal/A03-xihe/docs/dsd-decision-requirements.md L172",
      reviewDate: "2027-02-16",
      refs: [{ type: "task", id: "task-40" }, { type: "decision", id: "D-1743" }],
      replaces: [],
    },
    expect: { errors: 0, accepted: 1, warningIncludes: ["空数组"], externalId: "dsd-1-20261116-001", keys: ["decision", "externalId", "refs", "reviewDate", "timeHorizon"] },
  },
  {
    name: "缺 externalId（提案 id）必须被拒",
    raw: { decision: "没有提案 id 就没有幂等键，重试会重复建条。" },
    expect: { errors: 1, accepted: 0, errorIncludes: ["id 必须是字符串"] },
  },
  {
    name: "refs 方向违规（decision → bl）必须被拒",
    raw: { id: "dsd-1-20261116-002", decision: "反方向的引用不许进 refs。", refs: [{ type: "bl", id: "BL-584" }] },
    expect: { errors: 1, accepted: 0, errorIncludes: ["bl 不在其列"] },
  },
  {
    name: "replaces 缺省 vs 空数组",
    raw: { id: "dsd-1-20261116-003", decision: "缺省表示本条不声明取代任何旧条。" },
    expect: { errors: 0, accepted: 1, absentKeys: ["replaces"], warnings: 1, warningIncludes: ["timeHorizon 缺省"] },
  },
  {
    name: "同批 externalId 重复必须被拒（后一条）",
    raw: { id: "dsd-1-20261116-004", decision: "同批次里同一个幂等键出现两次，第二条应被拒。" },
    duplicateOfFirst: true,
    // 第一条合格、第二条被拒：断言走 duplicateOfFirst 专用检查，不套「第一条有错」的通用检查。
    expect: { accepted: 1, rejected: 1 },
  },
];

function selftest() {
  let failed = 0;
  const check = (cond, label) => {
    if (cond) process.stdout.write("  ok   " + label + "\n");
    else { process.stdout.write("  FAIL " + label + "\n"); failed += 1; }
  };
  for (const item of CASES) {
    process.stdout.write("[case] " + item.name + "\n");
    const entries = [{ source: "selftest:" + item.name, lane: "selftest", raw: item.raw }];
    if (item.duplicateOfFirst) entries.push({ source: "selftest:dup", lane: "selftest", raw: { ...item.raw } });
    const { batch, report } = buildBatch(entries);
    const first = report.entries[0];
    const expect = item.expect;
    if (expect.errors !== undefined) check(first.errors.length === expect.errors, "错误条数 = " + expect.errors + "（实际 " + first.errors.length + "）");
    if (expect.accepted !== undefined) check(batch.decisions.length === expect.accepted, "入参数 = " + expect.accepted + "（实际 " + batch.decisions.length + "）");
    for (const needle of expect.errorIncludes ?? []) check(first.errors.some((e) => e.includes(needle)), "错误含「" + needle + "」");
    for (const needle of expect.warningIncludes ?? []) check(first.warnings.some((w) => w.includes(needle)), "警告含「" + needle + "」");
    if (expect.warnings !== undefined) check(first.warnings.length === expect.warnings, "警告条数 = " + expect.warnings + "（实际 " + first.warnings.length + "）");
    if (expect.externalId) check(first.externalId === expect.externalId, "externalId 原样（" + expect.externalId + "）");
    for (const key of expect.keys ?? []) check(key in (batch.decisions[0] ?? {}), "入参含字段 " + key);
    for (const key of expect.absentKeys ?? []) check(!(key in (batch.decisions[0] ?? {})), "入参不含字段 " + key);
    if (expect.rejected !== undefined) check(report.rejected === expect.rejected, "被拒条数 = " + expect.rejected + "（实际 " + report.rejected + "）");
    if (item.duplicateOfFirst) check(report.entries[1].errors.some((e) => e.includes("本次扫描里重复")), "重复条目被拒");
  }
  process.stdout.write(failed === 0 ? "selftest: PASS（" + CASES.length + " 组）\n" : "selftest: FAIL（" + failed + " 项）\n");
  return failed === 0 ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 27).map((line) => line.replace(/^\/\/ ?/u, "")).join("\n") + "\n");
  process.exit(0);
}
if (args.selftest) process.exit(selftest());
process.exit(runMain(args));
