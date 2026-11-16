#!/usr/bin/env node
// 台账 → DSD 迁移脚本（task-406 / D-1245③，选项 A 双写起步）。
//
// 台账 D 号登记 SSOT 地位不动：本脚本只读台账，把 T1-e 口径的条目级候选
// 以 externalId=D号 幂等写入 DSD（查询面）。重跑安全：externalId 去重
// （377 ①），已存在行原样返回，不改一字。
//
// 口径（与 internal/A03-xihe/scripts/ledger-inventory.mjs 对齐）：
//   候选 = 表格定义行（^\|\s*\`?D-\d+）+ 标题条目（^#{3,4}\s+\`?D-\d+），
//   文件集 = 现行台账 + 卷 A。索引行（5 格、末格指向 卷A/§3）与全文条目
//   按 D 号去重：全文优先，索引行只贡献日期/状态元数据。
//
// 用法（零依赖，Node 24+）：
//   node scripts/migrate-ledger.mjs --dry-run [--strict] [--report <path>]
//     --strict = 盘点器 T1-e 原口径（###/#### + 表格行）严格子集复算（D-1251）
//   node scripts/migrate-ledger.mjs --database <abs-path> --recent 20 [--report <path>]
//   node scripts/migrate-ledger.mjs --database <abs-path> [--report <path>]
// task-27（D-1741：DSD 升为 D 号主存储）新增，缺省值不变：
//   --project-key <key> [--project-name <name>]  迁移目标项目（默认 xh-ledger）
//   --export <path>                              条目级 JSON 快照（--dry-run 亦可，只读台账）
//
// 退出码：0 成功 ｜ 2 输入读不出/空扫描 ｜ 1 迁移中出现存储拒绝（逐条报告）。
//
// 字段映射（394 证据 §3.2，D-1245③ 照准）：
//   externalId=D号；decision=条目全文；summary=标题；rationale=卷A理由格；
//   decisionDate=标题/正文/索引日期；sourceReference=文件+行号指针；
//   refs=正文抽取 PLAN-####/task-###/7+位 sha/D-### 互引（BL 提及留文本，
//   方向规则 decision 不引 bl）；replaces=显式整条取代对（升序创建，
//   部分取代/环/缺目标一律留正文并报告）。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SQLiteDecisionStore, validateDatabasePath } from "../src/storage/sqlite-store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ONE_ROOT = resolve(HERE, "../../../..");
const SOURCES = [
  { rel: "internal/A03-xihe/docs/lead-decisions-ledger.md", label: "lead-decisions-ledger.md" },
  { rel: "internal/A03-xihe/docs/archive/lead-decisions-2026-11-05-to-2026-11-08.md", label: "卷A" },
];
const PROJECT_KEY = "xh-ledger";
const PROJECT_NAME = "XH 代裁台账（迁移查询面）";

const RE = {
  row: /^\|\s*`?D-(\d+)`?\s*\|/,
  // 条目标题含 ##/###/#### 三级（台账格式演进：近期裁定多用 ##）。
  heading: /^(#{2,4})\s+`?D-(\d+)`?(.*)$/,
  // 严格 T1-e 口径（与盘点器逐字一致）只认 ###/####，单独计数对账。
  t1eHeading: /^#{3,4}\s+`?D-\d+/,
  // 项目符号式条目（§3 早期形态）：- **D-753｜标题**：正文…
  bullet: /^-\s+\*\*D-(\d+)[｜|]?(.*?)\*\*[：:]?\s*(.*)$/,
  // 粗体行首式条目（§3 近期大量形态，task-480）：**D-1248（标题…）**：正文…
  // 边界必须精确到「数字后紧跟全角（」——正文里的句首强调 **D-1117 的落点裁定
  // 不变**（… 不是条目（实测 D-1118 被它吞空）；同号补记/附记 **D-992 补记（…）**
  // 数字后是空格，不匹配本边界，按下方同号吸收规则并入母条目。
  bold: /^\*\*\s*`?(D-\d+(?:\s*[+／/、,，～~]\s*`?D?-?\d+)*)（(.*?)\*\*(.*)$/,
  // 同号附记（**D-1274 附记（…）**：数字后是标签词）：不是新条目边界，
  // 而是母条目的补录。标签是封闭集，别放成任意文本（task-480 的宽正则教训）。
  boldAdjunct: /^\*\*\s*`?(D-\d+)\s*(附记|补记|附注|补注|勘误)\s*（(.*?)\*\*(.*)$/,
  nextEntry: /^#{2,4}\s+`?D-\d+/,
  section: /^##\s+(?!.*`?D-\d)/,
  date: /(\d{4}-\d{2}-\d{2})/,
  plan: /\bPLAN-\d{4}\b/g,
  task: /\btask-\d+\b/g,
  sha: /\b[0-9a-f]{7,40}\b/g,
  dref: /\bD-\d+\b/g,
  bl: /\bBL-\d{3,4}\b/g,
  // 显式取代：主动语态（本条取代 D-xxx / 标题级取代 D-xxx），被动语态单独识别。
  replacesActive: /(?:本条|本裁定)?取代\*{0,2}\s*[：:]?\s*\*{0,2}`?D-(\d+)`?/g,
  replacesPassive: /被\s*\*{0,2}`?D-(\d+)`?\*{0,2}[^|。]{0,20}取代|已被\s*\*{0,2}`?D-(\d+)`?\*{0,2}\s*(?:取代|supersede)/gi,
  partial: /部分|①|②|③|前提|配套理由|事实判断/,
};

/**
 * 多号枚举展开（标题/粗体共用一份实现）：
 * - 区间「D-13 ～ D-16」= 13..16 全成员，不只是两个端点；
 * - 并列枚举的第二号常省略 D- 前缀（实测 main:9810「**D-1375+1376（…）**」，
 *   task-491 / dsd-1 独立盘点发现），故按「可选 D- + 数字」取号。
 */
function expandIdList(text) {
  const compact = text.replace(/\s+/g, "");
  const range = compact.match(/^D-(\d+)[～~]D-(\d+)$/);
  if (range) {
    return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => "D-" + (Number(range[1]) + k));
  }
  return [...text.matchAll(/D?-?(\d+)/g)].map((m) => "D-" + m[1]);
}

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    dryRun: false, recent: null, report: null, database: null, strict: false,
    // task-27 (D-1741)：DSD 升为 D 号主存储后，迁移目标项目由调用方指定。
    // 缺省仍是历史值 xh-ledger（脚本单测与既有报告不受影响）。
    projectKey: null, projectName: null,
    // task-27：导出条目级 JSON 快照（台账改指向/归档前的省力件）。与写入互不依赖。
    exportPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--recent") args.recent = Number(argv[++i]);
    else if (a === "--report") args.report = argv[++i];
    else if (a === "--database") args.database = argv[++i];
    else if (a === "--project-key") args.projectKey = argv[++i];
    else if (a === "--project-name") args.projectName = argv[++i];
    else if (a === "--export") args.exportPath = argv[++i];
    else die("未知参数: " + a, 1);
  }
  if (!args.dryRun && !args.database) die("--database 必填（或用 --dry-run 只盘点）", 1);
  if (args.recent !== null && (!Number.isInteger(args.recent) || args.recent < 1)) die("--recent 需正整数", 1);
  if (args.projectKey !== null && !/^[a-z0-9-]{1,48}$/u.test(args.projectKey)) die("--project-key 需小写 kebab-case（1-48）", 1);
  return args;
}

/**
 * 条目级 JSON 快照（task-27 / D-1741）。
 *
 * 用途：台账降级为待归档历史件时，其他 lane 的「运行时读取台账」需要改指向；
 * 这份快照就是最省力的改指向源（D 号 → 标题/正文/日期/出处/refs/replaces）。
 * 只读台账，不碰数据库；--dry-run 也能导出。
 */
function writeExport(exportPath, built, failed, args) {
  const sources = SOURCES.map((s) => {
    const abs = resolve(ONE_ROOT, s.rel);
    const bytes = readFileSync(abs);
    return { path: s.rel, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const entries = built.map((b) => ({
    externalId: b.externalId,
    ok: b.ok,
    source: { file: b.entry.file, line: b.entry.line, kind: b.entry.kind },
    ...(b.ok
      ? {
        summary: b.input.summary ?? null,
        decision: b.input.decision,
        rationale: b.input.rationale ?? null,
        decisionDate: b.input.decisionDate ?? null,
        sourceReference: b.input.sourceReference,
        refs: b.input.refs,
      }
      : { reasons: b.reasons }),
  }));
  const payload = {
    // 快照 schema 版本：guard-1（task-28）等下游按此判形态，破坏性变更必须递增。
    schemaVersion: 1,
    task: "task-27",
    mode: "export" + (args.strict ? "-strict" : ""),
    generatedAt: new Date().toISOString(),
    sources,
    counts: {
      candidates: entries.length,
      ok: entries.filter((e) => e.ok).length,
      failed: entries.filter((e) => !e.ok).length,
      failedIds: failed.map((f) => f.externalId),
    },
    entries,
  };
  const json = JSON.stringify(payload);
  mkdirSync(dirname(resolve(exportPath)), { recursive: true });
  writeFileSync(resolve(exportPath), json + "\n", "utf8");
  console.log("export → " + resolve(exportPath) + " (" + Buffer.byteLength(json, "utf8") + " B, " + entries.length + " entries)");
}

/** 表格行按未转义管道切格（两源文件实测无 \\| 转义）。 */
function cellsOf(line) {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function codePoints(value) { return Array.from(value).length; }

/** 从文本抽取 refs（方向合法四类；BL 只计数留文本）。插入序去重，上限 100。 */
function extractRefs(text, selfD) {
  const refs = [];
  const seen = new Set();
  const push = (type, id) => {
    const key = type + "\u0000" + id;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ type, id });
  };
  for (const m of text.matchAll(RE.plan)) push("plan", m[0]);
  for (const m of text.matchAll(RE.task)) push("task", m[0]);
  for (const m of text.matchAll(RE.sha)) {
    // sha 口径：7+ 位十六进制且同时含数字与字母（降低纯词误报）。
    if (/[0-9]/.test(m[0]) && /[a-f]/.test(m[0])) push("commit", m[0]);
  }
  const selfNum = Number(selfD.slice(2));
  for (const m of text.matchAll(RE.dref)) if (Number(m[0].slice(2)) !== selfNum) push("decision", m[0]);
  const blMentions = [...text.matchAll(RE.bl)].length;
  const truncated = refs.length > 100 ? refs.splice(100) : [];
  return { refs, blMentions, truncated };
}

/** 解析两个源文件 → 条目级候选，按 D 号去重。
 *
 * 口径分两层报告：
 *   - lineLevelT1e：与盘点器逐字一致的行级口径（表格行 + ###/#### 标题），
 *     用于和 inventory 对账（763 行 [实测 2026-11-14]）；
 *   - 条目级扩展：台账格式演进出的 ## 级标题与项目符号式条目同样是真实
 *     裁定条目，T1-e 正则未覆盖 ⇒ 一并解析、单独计数（level2Headings /
 *     bulletEntries），不漏近期裁定。
 * 非新条目形态：索引行（≤6 格、末格指 卷A/§3）只贡献元数据；状态核对
 * 回写行报告留痕；同号补录/补条/更正并入母条目正文（一字不丢）；
 * 多号标题（## D-802 / D-803 / D-804 / D-805）按号展开共享正文。
 */
function collectEntries(strict = false) {
  const raw = [];
  const statusNotes = [];
  let lineLevelT1e = 0;
  let level2Headings = 0;
  let bulletEntries = 0;
  let boldEntries = 0;
  let adjunctEntries = 0;
  let multiNumberHeadings = 0;
  // 严格模式 = 盘点器 T1-e 原口径（###/#### 标题 + 表格行），## 与项目符号式
  // 条目不解析；用于 D-1251 条件「严格子集可复算」。
  const headingRe = strict ? /^(#{3,4})\s+`?D-(\d+)`?(.*)$/ : RE.heading;
  const sectionRe = strict ? /^##\s/ : RE.section;
  for (const src of SOURCES) {
    const abs = join(ONE_ROOT, src.rel);
    if (!existsSync(abs)) die("缺输入文件: " + src.rel);
    const lines = readFileSync(abs, "utf8").split("\n");
    lineLevelT1e += lines.filter((l) => RE.row.test(l) || RE.t1eHeading.test(l)).length;
    let current = null;
    const flush = () => { if (current) { raw.push(current); current = null; } };
    lines.forEach((line, i) => {
      const lineNo = i + 1;
      const h = line.match(headingRe);
      if (h) {
        const level = h[1].length;
        const _dnum = Number(h[2]);
        if (level === 2) level2Headings += 1;
        // task-27 / D-1743 (P1)：同号吸收按**字符串 externalId** 比较，不按数字。
        // 卷 A 的 `| D-01 |` 与主册的 `**D-1（` 是两条正文互不相同的裁定；
        // 按数字比会把前者的 8 格正文并进后者 —— 实测跨条污染（dsd-1 task-27）。
        if (current && (current.extIds ?? [current.extId]).length === 1 && current.extId === "D-" + h[2]) {
          // 单号母条目的补录/补条/更正：append-only，属于母条目正文。
          // 多号批次不在此吸收成员详情标题（否则详情扩散到全体成员）。
          current.bodyLines.push(line);
          current.adjunctMerged = (current.adjunctMerged ?? []).concat([{ file: src.label, line: lineNo }]);
          return;
        }
        flush();
        // 多号展开只认标题起首的并列枚举（D-802 / D-803 / …）；
        // 标题里被修订/引用/撤销的 D 号不是并列条目（防跨条正文污染）。
        const enumMatch = line.match(/^#{2,4}\s+`?(D-\d+(?:\s*[+／/、,，～~]\s*`?D?-?\d+)*)/);
        const rawIds = enumMatch ? expandIdList(enumMatch[1]) : ["D-" + h[2]];
        const uniqueRaw = [...new Set(rawIds)];
        const uniqueDnums = uniqueRaw.map((s) => Number(s.slice(2)));
        if (uniqueDnums.length > 1) multiNumberHeadings += 1;
        current = {
          dnum: uniqueDnums[0], dnums: uniqueDnums, extId: uniqueRaw[0], extIds: uniqueRaw,
          kind: "heading", file: src.label, line: lineNo, level,
          headingLine: line,
          title: h[3].replace(/^[\s·:：-]+/, "").trim(),
          bodyLines: [],
        };
        return;
      }
      const b = strict ? null : line.match(RE.bullet);
      if (b) {
        flush();
        bulletEntries += 1;
        current = {
          dnum: Number(b[1]), dnums: [Number(b[1])], extId: "D-" + b[1], extIds: ["D-" + b[1]],
          kind: "bullet", file: src.label, line: lineNo,
          headingLine: line,
          title: b[2].trim(),
          bodyLines: b[3] ? [b[3]] : [],
        };
        return;
      }
      // 同号附记（**D-1274 附记（…）**）：先于粗体条目判断——它的数字后是标签词。
      // 母条目已开 ⇒ 直接 append（append-only）；未开 ⇒ 记 raw，等两遍去重时
      // 找到自己的号再并入（不依赖「当时正打开哪一条」——task-491 的病灶）。
      const ba = strict ? null : line.match(RE.boldAdjunct);
      if (ba) {
        const dnum = Number(ba[1].slice(2));
        if (current && (current.extIds ?? [current.extId]).includes(ba[1])) {
          current.bodyLines.push(line);
          current.adjunctMerged = (current.adjunctMerged ?? []).concat([{ file: src.label, line: lineNo }]);
          return;
        }
        // 附记是「侧插」：直接落 raw 交给第二遍并入，**不动 current** ——
        // 否则宿主条目在附记之后的正文会被并进附记那个号（task-491 回归，dsd-1 实测
        // main:3734：D-1046 的执行条款被并进 D-1044）。
        adjunctEntries += 1;
        const rest = ba[4].replace(/^[：:]\s*/, "").trim();
        raw.push({
          dnum, dnums: [dnum], extId: ba[1], extIds: [ba[1]],
          kind: "adjunct", file: src.label, line: lineNo,
          headingLine: line,
          title: ba[3].trim(),
          bodyLines: rest ? [rest] : [],
        });
        return;
      }
      const bo = strict ? null : line.match(RE.bold);
      if (bo) {
        const rawIds = expandIdList(bo[1]);
        const ids = rawIds.map((s) => Number(s.slice(2)));
        const single = ids.length === 1;
        if (current && single && (current.extIds ?? [current.extId]).length === 1 && current.extId === rawIds[0]) {
          // 同号补记/附记/补条（**D-992 补记…**）：append-only 归母条目正文。
          current.bodyLines.push(line);
          current.adjunctMerged = (current.adjunctMerged ?? []).concat([{ file: src.label, line: lineNo }]);
          return;
        }
        flush();
        if (single) boldEntries += 1; else multiNumberHeadings += 1;
        const inner = bo[2].replace(/\s*[）)]$/, "").trim();
        const rest = bo[3].replace(/^[：:]\s*/, "").trim();
        const extIds = rawIds; // task-27 (P1)：保留台账原样零填充（D-01 ≠ D-1）
        current = {
          dnum: ids[0], dnums: ids, extId: extIds[0], extIds,
          kind: "bold", file: src.label, line: lineNo,
          headingLine: line,
          title: inner,
          bodyLines: rest ? [rest] : [],
        };
        return;
      }
      if (current) {
        // 表格行也是条目边界：标题/项目符号条目正文里跟的表格，其 D 行是
        // 独立条目（卷A「## D-13 ～ D-16」后 66 行成员表曾是静默丢失源，
        // task-480 后由 D-1383 实测：吞进 heading 正文再被丢弃）。
        const boundary = RE.nextEntry.test(line) || sectionRe.test(line)
          || (current.kind === "bullet" && /^-\s/.test(line))
          || RE.row.test(line);
        if (boundary) { flush(); }
        else { current.bodyLines.push(line); return; }
      }
      const r = line.match(RE.row);
      if (r) {
        flush();
        const cells = cellsOf(line);
        const dnum = Number(r[1]);
        if (cells.length <= 6) {
          const last = cells[cells.length - 1] ?? "";
          if (/卷\s*A|§3/.test(last)) {
            raw.push({ dnum, kind: "index", file: src.label, line: lineNo, cells });
          } else {
            statusNotes.push({ dnum, file: src.label, line: lineNo, cells });
          }
          return;
        }
        raw.push({ dnum, extId: "D-" + r[1], kind: "row", file: src.label, line: lineNo, cells });
      }
    });
    flush();
  }

  // 去重：全文条目优先；索引行只贡献元数据；多号标题按号展开。
  const byD = new Map();
  const indexMeta = new Map();
  const mergeInto = (prev, entry) => {
    const fragment = entry.kind === "row"
      ? ["", entry.cells.join(" | ")]
      : entry.kind === "adjunct"
        ? ["", entry.headingLine] // 附记整行已含正文，bodyLines 是其子串，再并一遍就是纯重复
        : ["", entry.headingLine, ...entry.bodyLines];
    prev.bodyLines = (prev.bodyLines ?? []).concat(fragment);
    prev.merged = (prev.merged ?? []).concat([{ file: entry.file, line: entry.line }]);
  };
  // 两遍去重：先落真实条目，再把「同号附记」并进各自母条目。
  // 单遍会依赖「附记当时正打开哪一条」——task-491 实测：附记被别的条插开时
  // 就落进了别人的正文（D-1274/D-1272 → D-1275 等 6 例）。
  const ordered = [...raw.filter((e) => e.kind !== "adjunct"), ...raw.filter((e) => e.kind === "adjunct")];
  for (const entry of ordered) {
    if (entry.kind === "index") {
      const cells = entry.cells;
      indexMeta.set((entry.extIds ?? [entry.extId])[0], { date: (cells[1] ?? "").match(RE.date)?.[1] ?? null, status: cells[3] ?? null, file: entry.file, line: entry.line });
      continue;
    }
    const dnums = entry.dnums ?? [entry.dnum];
    const extIds = entry.extIds ?? [entry.extId];
    for (let k = 0; k < dnums.length; k += 1) {
      const dnum = dnums[k];
      const extId = extIds[k];
      // task-27 / D-1743 (P1)：去重键 = 字符串 externalId（D-01 与 D-1 各自成条）；
      // dnum 只留作排序与取代关系解析。
      const prev = byD.get(extId);
      if (!prev) { byD.set(extId, { ...entry, dnum, extId }); continue; }
      mergeInto(prev, entry);
    }
  }
  const entries = [...byD.values()].sort((a, b) => a.dnum - b.dnum || a.extId.localeCompare(b.extId));
  return {
    raw, lineLevelT1e, level2Headings, bulletEntries, boldEntries, adjunctEntries, multiNumberHeadings, statusNotes, entries, indexMeta,
    mergedSupplements: entries.filter((e) => e.merged || e.adjunctMerged).map((e) => ({
      d: e.extId, kept: { file: e.file, line: e.line },
      merged: (e.adjunctMerged ?? []).concat(e.merged ?? []),
    })),
  };
}

/** 一条候选 → DSD create 输入；解析失败返回 reasons（人工队列）。 */
function buildDecision(entry, indexMeta) {
  const reasons = [];
  const externalId = entry.extId; // 台账原样（D-01 保零填充）；去重键即此字符串（P1），排序按数字。
  const meta = indexMeta.get(entry.extId);
  let decision = null;
  let summary = null;
  let rationale = null;
  let dateText = null;

  if (entry.kind === "heading" || entry.kind === "bullet" || entry.kind === "bold" || entry.kind === "adjunct") {
    decision = entry.bodyLines.join("\n").trim();
    summary = entry.title || null;
    dateText = entry.title.match(RE.date)?.[1] ?? decision.match(RE.date)?.[1] ?? null;
    if (!decision) reasons.push("标题条目正文为空");
  } else {
    const cells = entry.cells;
    if (cells.length < 3) reasons.push("定义行不足 3 格");
    else {
      summary = cells[1] || null;
      decision = cells[2] || null;
      rationale = cells[3] || null;
      dateText = cells.map((c) => c.match(RE.date)?.[1]).find(Boolean) ?? null;
      if (!decision) reasons.push("定义行决策格为空");
      // 行条目若被并入后续补条（mergeInto 写入 bodyLines），内容必须并进
      // decision，不能静默丢弃（D-13 曾丢 23K 的先例）。
      const merged = (entry.bodyLines ?? []).join("\n").trim();
      if (merged) decision = decision ? decision + "\n" + merged : merged;
    }
  }
  if (dateText === null && meta?.date) dateText = meta.date;
  if (summary && codePoints(summary) > 300) { reasons.push("标题超 300 码点"); summary = null; }
  if (decision && codePoints(decision) > 20000) reasons.push("全文超 20000 码点");
  if (rationale && codePoints(rationale) > 20000) rationale = null;
  if (reasons.length) return { ok: false, externalId, reasons };

  const sourceReference = entry.file + " L" + entry.line + " (" + externalId + ")";
  const { refs, blMentions, truncated } = extractRefs(decision + "\n" + (rationale ?? "") + "\n" + (summary ?? ""), externalId);
  const input = { decision, externalId, refs, sourceReference };
  if (summary !== null) input.summary = summary;
  if (rationale !== null) input.rationale = rationale;
  if (dateText !== null) input.decisionDate = dateText;
  return { ok: true, externalId, input, blMentions, truncated, metaStatus: meta?.status ?? null };
}

/** 扫显式取代对：只接受整条、升序、无环、双方均在候选集者；其余留正文。
 * 来源二：卷 A 状态核对回写行的被动语态「被 D-xxx 取代/supersede」。 */
function scanReplaces(built, byDnum, statusNotes) {
  const edges = [];
  const leftInText = [];
  const consider = (fromD, toD, context, source) => {
    if (fromD === toD) return; // 自引（正文提及本条号）不构成取代。
    const from = byDnum.get(fromD)?.externalId ?? "D-" + fromD;
    const to = byDnum.get(toD)?.externalId ?? "D-" + toD;
    if (RE.partial.test(context)) { leftInText.push({ from, to, source, reason: "部分取代（上下文含部分/前提/理由标记）" }); return; }
    if (!byDnum.has(fromD) || !byDnum.has(toD)) { leftInText.push({ from, to, source, reason: "一方不在候选集" }); return; }
    if (toD >= fromD) { leftInText.push({ from, to, source, reason: "旧号不小于新号（升序创建不可表达）" }); return; }
    if (edges.some((e) => e.from === from && e.to === to)) return;
    edges.push({ from, to, source });
  };
  for (const b of built) {
    if (!b.ok) continue;
    const text = (b.input.summary ?? "") + "\n" + b.input.decision;
    for (const m of text.matchAll(RE.replacesActive)) {
      const context = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      const passive = /已被|被\s*`?D-/.test(text.slice(Math.max(0, m.index - 6), m.index));
      if (passive) { leftInText.push({ from: b.externalId, to: "D-" + Number(m[1]), source: "entry", reason: "被动语态（本条被取代，非本条取代）" }); continue; }
      consider(Number(b.externalId.slice(2)), Number(m[1]), context, "entry");
    }
  }
  for (const note of statusNotes) {
    const text = note.cells.join(" | ");
    for (const m of text.matchAll(RE.replacesPassive)) {
      const replacer = Number(m[1] ?? m[2]);
      if (!replacer) continue;
      const context = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
      consider(replacer, note.dnum, context, "status-writeback L" + note.line);
    }
  }
  // 环检测（每个新号至多取代若干旧号；沿 to 链走）。
  const byFrom = new Map();
  for (const e of edges) { (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)).push(e.to); }
  const acyclic = [];
  for (const e of edges) {
    const seen = new Set([e.from]);
    let cursor = e.to;
    let cycle = false;
    while (cursor) {
      if (seen.has(cursor)) { cycle = true; break; }
      seen.add(cursor);
      cursor = (byFrom.get(cursor) ?? [])[0] ?? null;
    }
    if (cycle) leftInText.push({ ...e, reason: "取代环" });
    else acyclic.push(e);
  }
  return { edges: acyclic, leftInText };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { raw, lineLevelT1e, level2Headings, bulletEntries, boldEntries, adjunctEntries, multiNumberHeadings, statusNotes, entries, indexMeta, mergedSupplements } = collectEntries(args.strict);
  if (lineLevelT1e === 0) die("空扫描：两源文件零候选（空扫不是通过）");

  const built = entries.map((e) => ({ entry: e, ...buildDecision(e, indexMeta) }));
  const failed = built.filter((b) => !b.ok);
  const ok = built.filter((b) => b.ok);
  // task-27 / D-1743 (P1)：同一数字可能有多条（D-1 与 D-01）。取代关系按数字解析，
  // 故每个数字取「无零填充」的那条作规范代表（台账里的取代写法一律是 D-1238 式）。
  const byDnum = new Map();
  for (const b of ok) {
    const n = Number(b.externalId.slice(2));
    const prev = byDnum.get(n);
    if (prev === undefined || (prev.externalId !== "D-" + n && b.externalId === "D-" + n)) byDnum.set(n, b);
  }
  const replaces = scanReplaces(ok, byDnum, statusNotes);
  const replacesByFrom = new Map();
  for (const e of replaces.edges) {
    (replacesByFrom.get(e.from) ?? replacesByFrom.set(e.from, []).get(e.from)).push(e.to);
  }

  let selected = ok;
  if (args.recent !== null) selected = [...ok].sort((a, b) => Number(b.externalId.slice(2)) - Number(a.externalId.slice(2))).slice(0, args.recent).sort((a, b) => Number(a.externalId.slice(2)) - Number(b.externalId.slice(2)));

  const report = {
    task: "task-406", mode: (args.dryRun ? "dry-run" : args.recent !== null ? "recent-" + args.recent : "full") + (args.strict ? "-strict" : ""),
    generatedAt: new Date().toISOString(),
    caliber: {
      lineLevelT1e,
      level2Headings,
      bulletEntries,
      boldEntries,
      adjunctEntries,
      multiNumberHeadings,
      entryLevelCandidates: raw.length,
      entryKinds: entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc; }, {}),
      uniqueEntries: entries.length,
      indexRowsMerged: indexMeta.size,
      statusWritebackRows: statusNotes.length,
      mergedSupplements,
      parsedOk: ok.length,
      parseFailed: failed.map((f) => ({ externalId: f.externalId, file: f.entry.file, line: f.entry.line, reasons: f.reasons })),
      selectedForMigration: selected.length,
      externalIds: ok.map((b) => b.externalId),
    },
    refs: {
      byType: { plan: 0, task: 0, commit: 0, decision: 0 },
      blMentionsLeftText: ok.reduce((n, b) => n + b.blMentions, 0),
      truncated: ok.filter((b) => b.truncated.length).map((b) => ({ externalId: b.externalId, dropped: b.truncated })),
    },
    replaces: { edges: replaces.edges, leftInText: replaces.leftInText },
    migration: null,
    spotChecks: [],
  };
  for (const b of ok) for (const r of b.input.refs) report.refs.byType[r.type] += 1;

  if (args.exportPath !== null) writeExport(args.exportPath, built, failed, args);

  if (!args.dryRun) {
    const databasePath = validateDatabasePath(args.database);
    const store = SQLiteDecisionStore.open({ databasePath });
    try {
      const projectKey = args.projectKey ?? PROJECT_KEY;
      const projectName = args.projectName ?? PROJECT_NAME;
      let project = store.getProjectByKey(projectKey);
      if (!project.ok) throw new Error("getProjectByKey: " + JSON.stringify(project.error));
      if (project.data === null) {
        const made = store.createProject({ name: projectName, projectKey });
        if (!made.ok) throw new Error("createProject: " + JSON.stringify(made.error));
        project = made;
      }
      const projectId = project.data.projectId;
      const idByExternal = new Map();
      let created = 0, alreadyExisted = 0, batches = 0, refused = [];
      const absorb = (result, externalId) => {
        if (!result.ok) { refused.push({ externalId, error: result.error }); return; }
        idByExternal.set(externalId, result.data.decisionId);
        if (result.data.alreadyExisted === true) alreadyExisted += 1; else created += 1;
      };
      let batch = [];
      const flush = () => {
        if (!batch.length) return;
        batches += 1;
        const result = store.createDecisionsBatch(projectId, { decisions: batch.map((b) => b.input) });
        if (!result.ok) { refused.push({ batch: batches, error: result.error }); batch = []; return; }
        result.data.decisions.forEach((row, i) => absorb({ ok: true, data: row }, batch[i].externalId));
        batch = [];
      };
      for (const b of selected) {
        const targets = replacesByFrom.get(b.externalId) ?? [];
        if (targets.length) {
          // 先 flush：目标可能还在待提交批里，flush 后其 id 才进映射。
          flush();
          const resolved = targets.map((t) => idByExternal.get(t)).filter((id) => id !== undefined);
          if (resolved.length !== targets.length) {
            report.replaces.leftInText.push({ from: b.externalId, to: targets.join(","), reason: "目标未先行入库（解析失败或乱序）" });
          }
          const input = resolved.length ? { ...b.input, replaces: resolved } : b.input;
          absorb(store.createDecision(projectId, input), b.externalId);
        } else {
          batch.push(b);
          if (batch.length === 100) flush();
        }
      }
      flush();
      report.migration = { projectId, projectKey, projectName: project.data.name, created, alreadyExisted, batches, refused };

      // 查询面抽查（真 store API，非桩）。
      const first = selected[0];
      if (first) {
        const id = idByExternal.get(first.externalId);
        const got = store.getDecision(projectId, { decisionId: id });
        report.spotChecks.push({ check: "get by migrated id", externalId: first.externalId, ok: got.ok && got.data.externalId === first.externalId });
        const planRef = selected.flatMap((b) => b.input.refs).find((r) => r.type === "plan");
        if (planRef) {
          const reverse = store.searchDecisions(projectId, { refType: "plan", refId: planRef.id });
          report.spotChecks.push({ check: "reverse refs query", ref: planRef, ok: reverse.ok && reverse.data.decisions.length > 0, hits: reverse.ok ? reverse.data.decisions.length : 0 });
        }
        // replaces 边落地验证：双方均已入库的边，新条目的 replaces 必含旧条目 id。
        for (const e of replaces.edges) {
          const fromId = idByExternal.get(e.from);
          const toId = idByExternal.get(e.to);
          if (fromId === undefined || toId === undefined) continue;
          const got = store.getDecision(projectId, { decisionId: fromId });
          const applied = got.ok && Array.isArray(got.data.replaces) && got.data.replaces.includes(toId);
          report.spotChecks.push({ check: "replaces edge applied", edge: e, ok: applied });
        }
        const list = store.searchDecisions(projectId, {});
        report.spotChecks.push({ check: "default list", ok: list.ok, total: list.ok ? list.data.decisions.length : 0, hasMore: list.ok ? list.data.hasMore : null });
        const kw = store.searchDecisions(projectId, { query: "裁定" });
        report.spotChecks.push({ check: "keyword search 裁定", ok: kw.ok, hits: kw.ok ? kw.data.decisions.length : 0 });
      }
    } finally {
      store.close();
    }
  }

  const json = JSON.stringify(report, null, 2);
  if (args.report) {
    mkdirSync(dirname(resolve(args.report)), { recursive: true });
    writeFileSync(resolve(args.report), json + "\n", "utf8");
    console.log("report → " + resolve(args.report));
  }
  console.log(json);
  const refusedCount = report.migration?.refused?.length ?? 0;
  process.exit(refusedCount > 0 ? 1 : 0);
}

main();
