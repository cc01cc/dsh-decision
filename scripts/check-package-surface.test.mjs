// task-147：包面闸门的两根轴。「无可校验目标」旧行为就是本卡要堵的缺口 —— 它让
// `files: []` + 无 main/exports/dsh 的包一路绿，而那个包装进 profile 是空的。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPackage, collectPluginShapeIssues } from "./check-package-surface.mjs";

function fixture(manifest, files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-surface-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body, "utf8");
    }
    return dir;
}

const VALID = {
    name: "@cc01cc/dsh-decision",
    main: "lib/index.js",
    exports: { ".": "./lib/index.js", "./package.json": "./package.json" },
    files: ["lib", "cordis.patch.yml"],
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
};

test("声明了但产物不存在 ⇒ 旧轴点名缺失（回归保护）", () => {
    const dir = fixture(VALID, { "cordis.patch.yml": "- insert: []\n" });
    const report = checkPackage(dir);
    // 两个缺失：\`./lib/index.js\`（main 与 exports["."] 指向同一路径，已按解析路径去重）
    // 与 \`lib\`（files 里的目录条目，目录本身不存在）。旧版把「目录条目」也算一个缺失。
    assert.equal(report.missing.length, 2);
    assert.deepEqual(report.missing.map((item) => item.target).sort(), ["./lib/index.js", "lib"]);
    assert.deepEqual(report.shapeIssues, []);
});

test("同一个包：产物齐了 ⇒ 两条轴都空", () => {
    const dir = fixture(VALID, { "lib/index.js": "export const name = 1;\n", "cordis.patch.yml": "- insert: []\n" });
    const report = checkPackage(dir);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.shapeIssues, []);
});

test("task-147 缺口：什么都不声明时旧轴为绿，新轴必须红", () => {
    const dir = fixture({ name: "@cc01cc/dsh-decision", files: [] });
    const report = checkPackage(dir);
    assert.equal(report.declaredCount, 0);
    assert.deepEqual(report.missing, []);
    assert.equal(report.shapeIssues.length, 3);
    assert.match(report.shapeIssues[0], /没有入口声明/);
    assert.match(report.shapeIssues[1], /dsh\.bundle\.patch/);
    assert.match(report.shapeIssues[2], /files 为空/);
});

test("单独判形态：只缺 dsh.bundle.patch 时只报这一条", () => {
    const issues = collectPluginShapeIssues({ main: "lib/index.js", files: ["lib"] });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /dsh\.bundle\.patch/);
});
