#!/usr/bin/env node
/**
 * A12-DSH-decision packaging-surface gate (task-85).
 *
 * Why this file exists: `packages/dsh-decision/package.json` declares an export surface
 * (`exports` -> four `./lib/typert.*` targets, mirrored in `files`), but `lib/` is empty and the
 * package has **no build script**. `pnpm pack` does not fail on missing `files` entries — it just
 * ships a tarball without them, so installing the package into DSH silently misses the entry points
 * and no existing gate notices. This gate is that missing judgement.
 *
 * What it checks (one axis, nothing else): **every file path a package declares as part of its
 * published surface must exist on disk.**
 *   - `exports` — walked recursively; string values that start with `./` are file targets,
 *     `null` entries are deliberately blocked subpaths and are skipped;
 *   - `files` — concrete entries (a path with an extension, or a directory) must resolve;
 *     glob patterns (`*`, `?`, `[]`, `{}`) are skipped because a pattern is not a target
 *     (expanding it would duplicate what `pnpm pack` already does);
 *   - `main` / `module` / `types` / `bin` — same rule, they are the same surface in another shape.
 *
 * What it deliberately does NOT check: whether a declared file is *stale*, whether `src/` is
 * type-checked, whether a build script exists, or whether the tarball really contains the file after
 * `pnpm pack`. Those are different judgements; mixing them in would make a red line ambiguous.
 *
 * Why the judgement is trustworthy: it fails when a declared target is missing (baseline: 4 missing
 * on the current tree) AND it goes green when the same declaration points at a file that exists
 * (see the two mutation readings recorded with the card) — a gate that is permanently red cannot
 * tell "the defect is there" from "the gate is broken".
 *
 * Usage: node scripts/check-package-surface.mjs [--root <dir>] [--json] [--help]
 * Exit:  0 every declared target exists / 1 at least one missing (named) / 2 usage error or IO failure
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Glob metacharacters: a pattern is not a target, so it cannot be "missing". */
const GLOB = /[*?[\]{}]/;

/** Condition keys are data, not code: any string value under `exports` is a target. */
function walkExportValue(value, trail, out) {
    if (value === null) return; // explicitly blocked subpath
    if (typeof (value) === "string") {
        if (value.startsWith("./")) out.push({ source: trail, target: value });
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, i) => walkExportValue(entry, trail + "[" + i + "]", out));
        return;
    }
    if (typeof (value) === "object") {
        for (const [key, entry] of Object.entries(value)) walkExportValue(entry, trail + "." + key, out);
    }
}

/**
 * Every file path the manifest promises to publish, with the declaration that promised it.
 * Exported so a test/one-off can judge a hand-written manifest without touching disk layout.
 */
export function collectDeclaredTargets(manifest) {
    const declared = [];
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
        walkExportValue(value, 'exports["' + subpath + '"]', declared);
    }
    (manifest.files ?? []).forEach((entry, i) => {
        if (typeof (entry) === "string" && !GLOB.test(entry)) {
            declared.push({ source: "files[" + i + "]", target: entry, mayBeDirectory: true });
        }
    });
    for (const key of ["main", "module", "types", "bin"]) {
        const value = manifest[key];
        if (typeof (value) === "string") declared.push({ source: key, target: value });
        else if (value && typeof (value) === "object") {
            for (const [name, entry] of Object.entries(value)) {
                if (typeof (entry) === "string") declared.push({ source: key + "." + name, target: entry });
            }
        }
    }
    return declared;
}

/** Workspace packages: `packages/<name>/package.json`. A repo without `packages/` is judged on its root. */
function findPackages(root) {
    const dirs = [];
    const packagesDir = path.join(root, "packages");
    if (fs.existsSync(packagesDir) && fs.statSync(packagesDir).isDirectory()) {
        for (const name of fs.readdirSync(packagesDir).sort()) {
            const dir = path.join(packagesDir, name);
            if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir);
        }
    }
    if (dirs.length === 0) {
        if (!fs.existsSync(path.join(root, "package.json"))) {
            throw new Error("no package.json under " + root + " (neither packages/*/package.json nor a root one)");
        }
        dirs.push(root);
    }
    return dirs;
}

/** Judge one directory. `missing` is deduped by resolved path but keeps every declaration that points at it. */
export function checkPackage(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const declared = collectDeclaredTargets(manifest);
    const byPath = new Map();
    for (const item of declared) {
        const abs = path.resolve(dir, item.target);
        const exists = fs.existsSync(abs);
        if (exists) continue;
        const directoryLike = Boolean(item.mayBeDirectory) && path.extname(item.target) === "";
        const bucket = byPath.get(abs) ?? { target: item.target, sources: [], directoryLike: false };
        bucket.sources.push(item.source);
        bucket.directoryLike = bucket.directoryLike || directoryLike;
        byPath.set(abs, bucket);
    }
    return {
        name: manifest.name ?? path.basename(dir),
        dir,
        declaredCount: declared.length,
        missing: [...byPath.values()],
    };
}

function usage(out) {
    out.write(
        "用法: node scripts/check-package-surface.mjs [--root <dir>] [--json] [--help]\n" +
            "判据: 包声明为发布面的每个文件路径都必须存在（exports / files / main / module / types / bin）。\n" +
            "退出码: 0 全部存在 / 1 有缺失（逐条点名）/ 2 用法或 IO 错误\n",
    );
}

function main(argv) {
    let root = path.resolve(HERE, "..");
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") json = true;
        else if (arg === "--help" || arg === "-h") {
            usage(process.stdout);
            return 0;
        } else if (arg === "--root") {
            const value = argv[++i];
            if (!value) {
                process.stderr.write("--root 需要一个目录\n");
                return 2;
            }
            root = path.resolve(value);
        } else {
            process.stderr.write("未知参数: " + arg + "（fail-closed，不用 argv.includes 静默放过错拼的开关）\n");
            return 2;
        }
    }
    if (!fs.existsSync(root)) {
        process.stderr.write("--root 指向的目录不存在: " + root + "\n");
        return 2;
    }

    let reports;
    try {
        reports = findPackages(root).map(checkPackage);
    } catch (error) {
        process.stderr.write("[check-package-surface] 读取失败: " + (error && error.message) + "\n");
        return 2;
    }

    const missingTotal = reports.reduce((sum, report) => sum + report.missing.length, 0);
    if (json) {
        process.stdout.write(JSON.stringify({ root, ok: missingTotal === 0, missingTotal, packages: reports }, null, 2) + "\n");
    } else if (missingTotal === 0) {
        for (const report of reports) {
            process.stdout.write(
                "[check-package-surface] " + report.name + ": " +
                    (report.declaredCount === 0
                        ? "没有任何发布面声明（无可校验目标）\n"
                        : report.declaredCount + " 个声明目标全部存在\n"),
            );
        }
    } else {
        for (const report of reports) {
            if (report.missing.length === 0) continue;
            process.stdout.write(
                "[check-package-surface] " + report.name + ": 声明了 " + report.declaredCount + " 个目标，" +
                    report.missing.length + " 个不存在 —— 装进消费方会静默缺产物\n",
            );
            for (const item of report.missing) {
                process.stdout.write(
                    "  ✗ " + item.target + "  ← " + item.sources.join(" / ") +
                        (item.directoryLike ? "（声明的是目录，该目录不存在）" : "") + "\n",
                );
            }
        }
        process.stdout.write(
            "[check-package-surface] 合计 " + missingTotal + " 个声明目标缺失（" +
                (path.relative(process.cwd(), root) || root) + " 下）\n",
        );
    }
    return missingTotal === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    process.exitCode = main(process.argv.slice(2));
}
