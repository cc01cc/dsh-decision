import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabasePath } from "../../src/host/config.ts";

// task-157 / D-1523：默认值表达式**只存在于包内 patch 文件**里 ——
// 这里从文件读出表达式字符串再 eval，绝不在测试里另抄一份（抄的那份会和发布的那份分叉）。
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const patchText = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");

function readDefaultExpression() {
    const match = /databasePath:\s*!!js\s+"(.+)"\s*$/mu.exec(patchText);
    assert.ok(match, "cordis.patch.yml 必须给出 !!js 的 databasePath 默认值表达式");
    return match[1];
}

/** 与 loader 的实现逐字同构：new Function("ctx","expr","with (ctx) { return eval(expr) }") */
function evaluate(expression, ctx) {
    const evaluateWith = new Function("ctx", "expr", `with (ctx) { return eval(expr) }`);
    return evaluateWith(ctx, expression);
}

test("task-157: patch 里的默认值表达式存在且带 !!js 标记", () => {
    assert.match(patchText, /databasePath:\s*!!js\s+"/u);
    assert.match(patchText, /- id: dsh-decision/u, "默认值必须挂在 dsh-decision 条目上");
    assert.equal(patchText.includes(":memory:"), false, "默认值不得是 :memory:");
});

test("task-157: 四种 baseUrl 输入各自算出预期路径（含 UNC / 无尾斜杠）", () => {
    const expression = readDefaultExpression();
    const cases = [
        {input: "file:///C:/Users/x/.dsh/profiles/desktop/", expect: "C:/Users/x/.dsh/profiles/desktop/decision.sqlite"},
        {input: "file://server/share/profiles/p/", expect: "//server/share/profiles/p/decision.sqlite"},
        {input: "file:///C:/Users/x/.dsh/profiles/desktop", expect: "C:/Users/x/.dsh/profiles/desktop/decision.sqlite"},
        {input: "file:///C:/Users/a%20b/.dsh/profiles/desktop/", expect: "C:/Users/a b/.dsh/profiles/desktop/decision.sqlite"},
    ];
    for (const item of cases) {
        assert.equal(evaluate(expression, {baseUrl: item.input}), item.expect, `输入 ${item.input}`);
    }
});

test("task-157: baseUrl 缺失时表达式返回 undefined（不抛），并落到可操作报错", () => {
    const expression = readDefaultExpression();
    assert.equal(evaluate(expression, {}), undefined);
    assert.equal(evaluate(expression, {baseUrl: ""}), undefined);
    // 默认值缺失时必须仍是「缺 databasePath」+ help 段，而不是拼出一个猜测路径
    assert.throws(
        () => resolveDatabasePath({databasePath: evaluate(expression, {})}),
        (error) => {
            assert.match(error.message, /Invalid decision plugin Config: \$\.databasePath missing required value/u);
            assert.match(error.message, /NO default/u);
            return true;
        },
    );
});

test("task-157: 默认值算出的路径能通过正式校验（不在包内、不含 node_modules）", () => {
    const expression = readDefaultExpression();
    const resolved = resolveDatabasePath({databasePath: evaluate(expression, {baseUrl: "file:///C:/Users/x/.dsh/profiles/desktop/"})});
    assert.equal(resolved, "C:/Users/x/.dsh/profiles/desktop/decision.sqlite");
});
