#!/usr/bin/env node
/**
 * A12-DSH-decision commit message gate — the minimal subset (task-29).
 *
 * Why this file exists: `xh-commit` guard ⑦ resolves the gate **per target repo**
 * (`<repo>/scripts/check-commit-msg.mjs`, xh-commit.mjs:560). A12 had no such file, so
 * the guard printed `skip: 无消息门禁脚本` and blocked nothing (task-24 reading: 35 commits,
 * 0 gated). Creating it is the whole wiring — the guard calls this script with `--file`
 * and treats any non-zero exit as `E_MSG_GATE` (fail-closed, ref untouched).
 *
 * Scope — deliberately five rules, nothing more (task-24 A/B: A = port A03's 295-line gate,
 * B = this file; B was chosen because A's extra rules are warn-only on this repo (20/20 clean)
 * while adding two parameters a human would have to keep deciding: `task-\d+` and DEFAULT_SINCE):
 *   1. subject display width <= 72 columns (CJK/fullwidth count 2) — blocking;
 *   2. subject is `type(scope): summary`, type from TYPES — blocking;
 *   3. a reference (task-NNN / PLAN-NNNN / BL-NNN / D-NNN) — WARN only: 4 of the last
 *      20 real commits carry none, and blocking it would stop real work;
 *   4. unknown arguments => exit 2, fail-closed (the older `one/scripts` gate uses
 *      `argv.includes` and silently ignores a mistyped flag while still reporting PASS);
 *   5. default = the single HEAD commit, NOT `root..HEAD`: two commits in this repo's
 *      history are over width (`e0a1cbbc` 73, `d4765ab7` 85) and stay historical facts.
 *
 * Not included on purpose: body width, emoji, vague-word, blank-line, allowlist file,
 * `--stats`, `--report-only`, streaming `git log` — 35 commits fit one read.
 *
 * Usage:  node scripts/check-commit-msg.mjs [--file <path>] [--range <a..b>] [--json] [--help]
 * Exit:   0 pass (warnings allowed) / 1 violation / 2 usage error or git read failure
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Types the repo actually uses (feat 16 / fix 8 / docs 7 / test 2 / chore 1) + style (task-29). */
const TYPES = new Set(["feat", "fix", "docs", "test", "style", "chore"]);
export const DEFAULT_LIMITS = { subjectMax: 72, mergeMax: 100 };
/** A12's id space is task-NNN; PLAN/BL/D are accepted because the ledger uses them too. */
const REFS = /(task-\d+|PLAN-\d{4}|BL-\d{3}|D-\d{3,4})/;
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Display width: CJK / fullwidth / kana count as two columns. */
export function width(text) {
  return [...text].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
}

/**
 * Judge one message. `limits` is a parameter only so the width judgement can be
 * re-run under a different bound (the self-test's mutation fixture: padding the bound
 * to 200 must make the 73-column fixture pass — proving the check is live, not恒绿).
 */
export function checkMessage(raw, limits = DEFAULT_LIMITS) {
  const text = String(raw).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = text.split("\n");
  const subject = lines[0] ?? "";
  const body = lines.slice(1).join("\n");
  const errors = [];
  const warns = [];
  const isMerge = /^merge(\(|:)/.test(subject) || /^Merge (branch|remote-tracking) /.test(subject);
  const limit = isMerge ? limits.mergeMax : limits.subjectMax;
  const measured = width(subject);
  if (measured > limit) {
    errors.push({
      code: "E_SUBJECT_TOO_WIDE",
      message: `首行显示宽度 ${measured} 列 > ${limit} 列（CJK 记 2 列；约 ${Math.floor(limit / 2)} 个汉字）。把细节移到 body。`,
    });
  }
  if (!isMerge) {
    const m = subject.match(/^([a-z]+)(?:\(([A-Za-z0-9._/-]+)\))?!?: (.+)$/);
    if (!m) {
      errors.push({ code: "E_SUBJECT_FORMAT", message: "首行应为 `<type>(<scope>): <摘要>`（scope 可省）" });
    } else {
      if (!TYPES.has(m[1])) errors.push({ code: "E_BAD_TYPE", message: `type \`${m[1]}\` 不在白名单：${[...TYPES].join("|")}` });
      if (!m[3].trim()) errors.push({ code: "E_EMPTY_SUBJECT", message: "摘要是空的" });
    }
    if (!REFS.test(subject) && !REFS.test(body)) {
      warns.push({ code: "W_NO_REF", message: "未引用 task-####/PLAN-####/BL-###/D-###（只 warn，不阻断）" });
    }
  }
  return { subject, width: measured, limit, isMerge, errors, warns };
}

const USAGE = `用法: node scripts/check-commit-msg.mjs [--file <路径>] [--range <a..b>] [--json] [--help]

判据（五条）:
  1 首行显示宽度 ≤ ${DEFAULT_LIMITS.subjectMax} 列（CJK 记 2；merge 首行 ≤ ${DEFAULT_LIMITS.mergeMax}）—— 阻断
  2 首行 \`<type>(<scope>): <摘要>\`，type ∈ ${[...TYPES].join("|")} —— 阻断
  3 引用 task-####/PLAN-####/BL-###/D-### —— 只 warn
  4 未知参数 exit 2（fail-closed）
  5 默认只校验 HEAD 这一笔

--range 说明：本仓历史有 2 笔超宽（e0a1cbbc 73 列、d4765ab7 85 列，属既成事实）。
用 --range <root>..HEAD 跑全历史**会红这 2 笔**，那是设计如此；不要为变绿改写历史。`;

const BOOLEAN_FLAGS = new Map([["--json", "json"], ["--help", "help"]]);
const VALUE_FLAGS = new Map([["--file", "file"], ["--range", "range"]]);

function parseArgs(argv) {
  const opts = { json: false, help: false, file: undefined, range: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const boolKey = BOOLEAN_FLAGS.get(arg);
    if (boolKey) {
      opts[boolKey] = true;
      continue;
    }
    const valueKey = VALUE_FLAGS.get(arg);
    if (valueKey) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `参数缺值: ${arg}` };
      opts[valueKey] = value;
      i += 1;
      continue;
    }
    return { error: arg.startsWith("-") ? `未知参数: ${arg}` : `未知位置参数: ${arg}` };
  }
  if (opts.file !== undefined && opts.range !== undefined) return { error: "参数冲突: --file 与 --range 不能同时给" };
  return { opts };
}

/** Read the commits to judge. Any git failure is a usage-level error (exit 2), never a pass. */
function readEntries(opts) {
  if (opts.file !== undefined) {
    if (!fs.existsSync(opts.file)) return { error: `找不到消息文件：${opts.file}` };
    return { entries: [{ label: opts.file, message: fs.readFileSync(opts.file, "utf8") }] };
  }
  const span = opts.range ?? "HEAD";
  const args = span === "HEAD" ? ["log", "-1", "--pretty=format:%H%x1f%B%x1e"] : ["log", span, "--pretty=format:%H%x1f%B%x1e"];
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.error) return { error: `git 无法执行：${res.error.message}` };
  if (res.status !== 0) return { error: `git log ${span} 失败：${(res.stderr ?? "").trim().split("\n")[0] || "退出码 " + res.status}` };
  const entries = String(res.stdout ?? "")
    .split("\x1e")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const [sha, ...rest] = frame.split("\x1f");
      return { label: sha.slice(0, 8), message: rest.join("\x1f") };
    });
  if (entries.length === 0) return { error: `git log ${span} 没有返回提交` };
  return { entries };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  const { opts } = parsed;
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const read = readEntries(opts);
  if (read.error) {
    console.error(read.error);
    process.exit(2);
  }
  const rows = read.entries.map((entry) => ({ label: entry.label, ...checkMessage(entry.message) }));
  const errorCount = rows.reduce((n, row) => n + row.errors.length, 0);
  const warnCount = rows.reduce((n, row) => n + row.warns.length, 0);
  if (opts.json) {
    console.log(JSON.stringify({ rows: rows.map((r) => ({ ...r, ok: r.errors.length === 0 })), errors: errorCount, warns: warnCount }, null, 2));
  } else {
    for (const row of rows) {
      console.log(`[${row.errors.length ? "FAIL" : "PASS"}] ${row.label}  首行 ${row.width}/${row.limit} 列${row.isMerge ? "（merge）" : ""}`);
      console.log(`        ${row.subject}`);
      for (const e of row.errors) console.log(`  ✗ ${e.code}: ${e.message}`);
      for (const w of row.warns) console.log(`  · ${w.code}: ${w.message}`);
    }
    if (rows.length > 1) console.log(`\n共 ${rows.length} 条，错误 ${errorCount}，警告 ${warnCount}`);
  }
  process.exit(errorCount ? 1 : 0);
}

// Run only as a CLI (Node ≥24 `import.meta.main`): the self-test imports
// { checkMessage, width } from this module. No env switch — a "skip the gate" knob is
// exactly the bypass this file exists to prevent.
if (import.meta.main) main();
