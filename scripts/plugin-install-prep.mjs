#!/usr/bin/env node
/**
 * task-147 第 5 步（把 @cc01cc/dsh-decision 装进 profile）的**装前/回滚**工具。
 *
 * 为什么单独做一个脚本而不是一串手打命令：这次要改的是**别人正在用的 profile**
 * （`~/.dsh/profiles/desktop`）。手打 `Copy-Item` 有两个已知坑：① 覆盖后 mtime 不刷新
 * （D-1487 的假绿来源）；② 回滚后没人验，`copy` 成功 ≠ 内容一致。所以这里把三件事做成
 * 可复算的：**备份 + sha256 记账 + 回滚后校验 sha256 必须等于原值**。
 *
 * 用法：
 *   node scripts/plugin-install-prep.mjs backup  --profile <dir> --to <backupDir>
 *   node scripts/plugin-install-prep.mjs verify  --profile <dir> --from <backupDir>
 *   node scripts/plugin-install-prep.mjs rollback --profile <dir> --from <backupDir>
 * 退出码：0 通过 / 1 校验不通过（逐条点名）/ 2 用法或 IO 错误
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 只备份这三个：清单、profile 的 patch 层、以及 pnpm workspace 声明（安装会动它）。 */
const TARGETS = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".npmrc"];

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
    const out = { command: argv[0] };
    for (let i = 1; i < argv.length; i += 2) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === "--profile") out.profile = value;
        else if (key === "--to") out.to = value;
        else if (key === "--from") out.from = value;
        else return { error: "未知参数: " + key };
    }
    return out;
}

function backup(args) {
    const entries = [];
    fs.mkdirSync(args.to, { recursive: true });
    for (const name of TARGETS) {
        const from = path.join(args.profile, name);
        if (!fs.existsSync(from)) {
            entries.push({ name, present: false });
            continue;
        }
        const to = path.join(args.to, name);
        fs.copyFileSync(from, to);
        const expected = sha256(from);
        const actual = sha256(to);
        if (expected !== actual) throw new Error("备份后 sha256 不一致: " + name);
        entries.push({ name, present: true, sha256: expected, bytes: fs.statSync(from).size });
    }
    const manifest = { profile: path.resolve(args.profile), takenAt: new Date().toISOString(), entries };
    fs.writeFileSync(path.join(args.to, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    for (const entry of entries) {
        process.stdout.write("[prep] " + (entry.present ? "已备份 " + entry.name + "  sha256=" + entry.sha256 + "  " + entry.bytes + " bytes" : "不存在（跳过）" + entry.name) + "\n");
    }
    return 0;
}

function loadManifest(dir) {
    const file = path.join(dir, "backup-manifest.json");
    if (!fs.existsSync(file)) throw new Error("备份目录里没有 backup-manifest.json: " + dir);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function verify(args) {
    const manifest = loadManifest(args.from);
    let bad = 0;
    for (const entry of manifest.entries) {
        const live = path.join(args.profile, entry.name);
        if (!entry.present) continue;
        if (!fs.existsSync(live)) {
            process.stdout.write("[prep] ✗ " + entry.name + " 不存在（备份时存在）\n");
            bad += 1;
            continue;
        }
        const actual = sha256(live);
        const ok = actual === entry.sha256;
        process.stdout.write("[prep] " + (ok ? "✓" : "✗") + " " + entry.name + "  live=" + actual + "  备份=" + entry.sha256 + "\n");
        if (!ok) bad += 1;
    }
    process.stdout.write("[prep] verify: " + (bad === 0 ? "全部与备份一致" : bad + " 个文件与备份不一致") + "\n");
    return bad === 0 ? 0 : 1;
}

function rollback(args) {
    const manifest = loadManifest(args.from);
    for (const entry of manifest.entries) {
        if (!entry.present) continue;
        const from = path.join(args.from, entry.name);
        const live = path.join(args.profile, entry.name);
        fs.copyFileSync(from, live);
        // copyFileSync 会刷新 mtime（不像 Copy-Item 的旧实现），但仍显式 touch 一次：
        // 安装器若按 mtime 判「是否需要处理」，回滚也必须让文件看起来是新的。
        const now = new Date();
        fs.utimesSync(live, now, now);
        process.stdout.write("[prep] 已回滚 " + entry.name + "\n");
    }
    return verify({ profile: args.profile, from: args.from });
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.error || !args.command) {
        process.stderr.write((args.error ? args.error + "\n" : "") + "用法: node scripts/plugin-install-prep.mjs <backup|verify|rollback> --profile <dir> (--to|--from) <dir>\n");
        return 2;
    }
    const needsTo = args.command === "backup";
    if (!args.profile || (needsTo ? !args.to : !args.from)) {
        process.stderr.write("缺少 --profile 或 " + (needsTo ? "--to" : "--from") + "\n");
        return 2;
    }
    try {
        if (args.command === "backup") return backup(args);
        if (args.command === "verify") return verify(args);
        if (args.command === "rollback") return rollback(args);
        process.stderr.write("未知命令: " + args.command + "\n");
        return 2;
    } catch (error) {
        process.stderr.write("[prep] 失败: " + (error && error.message) + "\n");
        return 2;
    }
}

process.exitCode = main(process.argv.slice(2));
