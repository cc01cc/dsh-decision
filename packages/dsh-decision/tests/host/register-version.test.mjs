import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_TOOLS_VERSION_LINE, isCompatibleHostToolsVersion } from "../../src/host/register.ts";

// task-167：D-1238 的 fail-closed 版本闸必须保留，只是判据从「点」改成「线」。
// 这些用例故意把「常量」当输入源：常量改错 ⇒ 下面的线内/线外断言就会红。

test("task-167: 同一 runtime 线的任何 rc 序号都放行", () => {
    const line = HOST_TOOLS_VERSION_LINE;
    for (const rc of ["rc.1", "rc.3", "rc.99"]) {
        assert.equal(isCompatibleHostToolsVersion(`${line}-${rc}`), true, `${line}-${rc} 应放行`);
    }
    assert.equal(isCompatibleHostToolsVersion(line), true, "正式版与 rc 同属一个编译面");
});

test("task-167: 线外版本一律拒绝（fail-closed 不许改松）", () => {
    const [major, minor, patch] = HOST_TOOLS_VERSION_LINE.split(".").map(Number);
    const rejected = [
        `${major}.${minor}.${patch + 1}`,
        `${major}.${minor}.${patch + 1}-rc.1`,
        `${major}.${minor + 1}.0`  ,
        `${major}.${minor}.${Math.max(0, patch - 1)}`,
        `${major + 1}.0.0`,
        "",
        "banana",
        `${HOST_TOOLS_VERSION_LINE}-beta.1`,
        "v0.2.2-rc.1",
    ];
    for (const version of rejected) {
        assert.equal(isCompatibleHostToolsVersion(version), false, `${JSON.stringify(version)} 应被拒`);
    }
});

test("task-167: 本次修复对应的真实值（0.2.2-rc.3）通过，旧的写死值不再是判据", () => {
    assert.equal(isCompatibleHostToolsVersion("0.2.2-rc.3"), true);
    // 回归保护：判据若被改回「必须等于某个 rc 点」，上面「rc.1/rc.3/rc.99 都放行」那条就会红。
    assert.equal(isCompatibleHostToolsVersion("0.2.2-rc.7"), true);
});
