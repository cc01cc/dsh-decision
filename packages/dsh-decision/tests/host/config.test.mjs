import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Config, apply, getDecisionStore, openConfiguredStore, resolveDatabasePath } from "../../src/host/config.ts";

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-config-"));
  tempRoots.add(root);
  return root;
}

function fakeContext() {
  const disposers = [];
  return {
    ctx: {
      effect(execute) {
        const disposer = execute();
        disposers.push(disposer);
        return disposer;
      },
    },
    disposeAll() {
      for (const disposer of disposers.splice(0)) {
        if (typeof disposer === "function") disposer();
      }
    },
  };
}

function getDecisionStoreOrUndefined(ctx) {
  try {
    return getDecisionStore(ctx);
  } catch {
    return undefined;
  }
}

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Config schema requires a non-empty databasePath and exposes no default", () => {
  const validate = Config;
  assert.throws(() => validate({}), /databasePath/i);
  assert.throws(() => validate({ databasePath: "" }), /databasePath|length/i);
  assert.throws(() => validate(undefined), /databasePath/i);
  assert.deepEqual(validate({ databasePath: "/tmp/profile.sqlite" }), { databasePath: "/tmp/profile.sqlite" });
  assert.equal(Config.toString().includes("databasePath: string"), true);
});

test("resolveDatabasePath fails closed on missing, empty, relative, and in-memory paths", () => {
  assert.throws(() => resolveDatabasePath(undefined), /Invalid decision plugin Config/i);
  assert.throws(() => resolveDatabasePath(null), /Invalid decision plugin Config/i);
  assert.throws(() => resolveDatabasePath({}), /Invalid decision plugin Config/i);
  assert.throws(() => resolveDatabasePath({ databasePath: "" }), /Invalid decision plugin Config/i);
  assert.throws(() => resolveDatabasePath({ databasePath: "   " }), /absolute databasePath/i);
  assert.throws(() => resolveDatabasePath({ databasePath: "relative.sqlite" }), /absolute databasePath/i);
  assert.throws(() => resolveDatabasePath({ databasePath: "nested/relative.sqlite" }), /absolute databasePath/i);
  assert.throws(() => resolveDatabasePath({ databasePath: ":memory:" }), /absolute databasePath/i);
});

test("openConfiguredStore never invents a parent directory or a fallback root", () => {
  const root = tempRoot();
  const missingParent = join(root, "not-created", "nested");
  assert.throws(() => openConfiguredStore({ databasePath: join(missingParent, "decisions.sqlite") }));
  assert.equal(existsSync(missingParent), false);
});

test("resolveDatabasePath rejects an existing directory and package/node_modules targets", () => {
  const root = tempRoot();
  const directoryTarget = join(root, "a-directory");
  mkdirSync(directoryTarget);
  assert.throws(() => resolveDatabasePath({ databasePath: directoryTarget }), /not an existing directory/i);

  assert.throws(() => resolveDatabasePath({ databasePath: join(pluginRoot, "profile.sqlite") }), /inside the plugin package/i);
  assert.throws(() => resolveDatabasePath({ databasePath: join(pluginRoot, "node_modules", "profile.sqlite") }), /inside the plugin package/i);

  const fakeNodeModules = join(root, "node_modules", "profile.sqlite");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  assert.throws(() => resolveDatabasePath({ databasePath: fakeNodeModules }), /node_modules/i);
});

test("openConfiguredStore accepts a valid absolute path and rejects the same invalid ones", (t) => {
  const root = tempRoot();
  const databasePath = join(root, "decisions.sqlite");
  const store = openConfiguredStore({ databasePath });
  t.after(() => store.close());
  assert.equal(store.databasePath, databasePath);
  assert.throws(() => openConfiguredStore({ databasePath: "relative.sqlite" }), /absolute databasePath/i);
  assert.throws(() => openConfiguredStore({}), /Invalid decision plugin Config/i);
});

test("apply throws during load on invalid Config, before opening any store", () => {
  const fake = fakeContext();
  assert.throws(() => apply(fake.ctx, {}), /Invalid decision plugin Config/i);
  assert.throws(() => apply(fake.ctx, { databasePath: "relative.sqlite" }), /absolute databasePath/i);
  assert.equal(getDecisionStoreOrUndefined(fake.ctx), undefined);
});

test("apply opens the store on the plugin context and closes it on unload", () => {
  const root = tempRoot();
  const databasePath = join(root, "decisions.sqlite");
  const fake = fakeContext();
  apply(fake.ctx, { databasePath });
  const store = getDecisionStore(fake.ctx);
  assert.equal(store.databasePath, databasePath);
  assert.equal(store.createProject({ name: "Atlas", projectKey: "atlas" }).ok, true);
  fake.disposeAll();
  assert.equal(getDecisionStoreOrUndefined(fake.ctx), undefined);
  assert.throws(() => store.createProject({ name: "Beta", projectKey: "beta" }), /closed/i);
});

test("apply rejects a Config whose databasePath points inside node_modules", () => {
  const fake = fakeContext();
  const databasePath = join(tempRoot(), "node_modules", "profile.sqlite");
  assert.throws(() => apply(fake.ctx, { databasePath }), /node_modules/i);
  assert.equal(getDecisionStoreOrUndefined(fake.ctx), undefined);
});

test("task-147: 缺 databasePath 的报错必须可照做（含形态与示例）", () => {
    // 实测缺口：profile 只 insert 了 id/name 时，报错只有「$.databasePath missing required value」，
    // 用户看不出该填什么。这里只断言关键短语，不锁整句（措辞会随 i18n/文案调整）。
    assert.throws(
        () => resolveDatabasePath({}),
        (error) => {
            assert.match(error.message, /Invalid decision plugin Config/u);
            assert.match(error.message, /databasePath/u);
            assert.match(error.message, /NO default/u);
            assert.match(error.message, /absolute path/u);
            assert.match(error.message, /not inside node_modules/u);
            assert.match(error.message, /cordis\.patch\.yml/u);
            return true;
        },
    );
});
