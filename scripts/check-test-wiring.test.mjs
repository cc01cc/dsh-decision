import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findProblems, formatProblems, listTestFiles, referencedTests } from "./check-test-wiring.mjs";

/**
 * The gate itself needs a gate: an always-red or always-green checker would pass
 * review. Every case below builds a throwaway tree, so the assertions never
 * depend on this repository staying in one shape.
 */

const GATE = fileURLToPath(new URL("./check-test-wiring.mjs", import.meta.url));
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = new Set();

after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
  fixtures.clear();
});

/** files: repo-relative paths to create (content is irrelevant); scripts: package.json scripts. */
function fixture(files, scripts) {
  const root = mkdtempSync(join(tmpdir(), "test-wiring-") + "-");
  fixtures.add(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2));
  for (const file of files) {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "// fixture\n");
  }
  return root;
}

function runGate(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout) };
  }
}

// ------------------------------------------------------- the real repository

test("wiring gate: this repository has no orphan and no missing test file", () => {
  const problems = findProblems(REPO);
  assert.equal(problems.orphans.length, 0, "orphans: " + problems.orphans.join(", "));
  assert.equal(problems.missing.length, 0, "missing: " + problems.missing.join(", "));
  assert.equal(problems.tests.length, problems.referenced.size, "every on-disk test is named");
});

test("wiring gate: the four files that were missing on 2026-11-15 stay wired", () => {
  const referenced = referencedTests(REPO);
  const formerlyOrphaned = [
    "packages/dsh-decision/tests/executor/executor-matrix.test.mjs",
    "packages/dsh-decision/tests/host/wiring.test.mjs",
    "packages/dsh-decision/tests/scripts/ledger-fixtures.test.mjs",
    "packages/dsh-decision/tests/scripts/ledger-migration.test.mjs",
  ];
  for (const file of formerlyOrphaned) {
    assert.equal(referenced.has(file), true, "not wired: " + file);
  }
});

// ------------------------------------------------------- orphan detection

test("wiring gate: an orphan test file fails the gate and is named", () => {
  const root = fixture(["tests/wired.test.mjs", "tests/tmp-orphan.test.mjs"], {
    test: "node --test tests/wired.test.mjs",
  });
  const problems = findProblems(root);
  assert.deepEqual(problems.orphans, ["tests/tmp-orphan.test.mjs"]);
  const report = formatProblems(root, problems);
  assert.equal(report.includes("ORPHAN  tests/tmp-orphan.test.mjs"), true, report);
  const run = runGate(root);
  assert.equal(run.code, 1, "gate must exit 1");
  assert.equal(run.stdout.includes("tests/tmp-orphan.test.mjs"), true, "gate must name the file");
});

test("wiring gate: dropping a path from a script turns that file into an orphan", () => {
  const files = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const wired = fixture(files, { test: "node --test tests/a.test.mjs tests/b.test.mjs" });
  assert.deepEqual(findProblems(wired).orphans, [], "both wired => clean");
  const dropped = fixture(files, { test: "node --test tests/a.test.mjs" });
  const problems = findProblems(dropped);
  assert.deepEqual(problems.orphans, ["tests/b.test.mjs"], "removing the path must expose b");
  assert.equal(runGate(dropped).code, 1);
});

test("wiring gate: a package-level script is resolved against its own directory", () => {
  const root = fixture(["packages/p/tests/x.test.mjs"], { test: "node --test packages/p/tests/x.test.mjs" });
  assert.deepEqual(findProblems(root).orphans, [], "root-relative path is fine");
  const nested = mkdtempSync(join(tmpdir(), "test-wiring-nested-") + "-");
  fixtures.add(nested);
  mkdirSync(join(nested, "packages/p/tests"), { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify({ scripts: { test: "echo none" } }));
  writeFileSync(join(nested, "packages/p/package.json"), JSON.stringify({ scripts: { test: "node --test tests/x.test.mjs" } }));
  writeFileSync(join(nested, "packages/p/tests/x.test.mjs"), "// x\n");
  const problems = findProblems(nested);
  assert.deepEqual(problems.orphans, [], "tests/x.test.mjs resolves inside packages/p");
  assert.deepEqual([...problems.referenced.keys()], ["packages/p/tests/x.test.mjs"]);
});

test("wiring gate: a script naming a test file that does not exist is fatal", () => {
  const root = fixture(["tests/a.test.mjs"], { test: "node --test tests/a.test.mjs tests/gone.test.mjs" });
  const problems = findProblems(root);
  assert.deepEqual(problems.missing, ["tests/gone.test.mjs"]);
  assert.equal(formatProblems(root, problems).includes("MISSING tests/gone.test.mjs"), true);
  assert.equal(runGate(root).code, 1);
});

// ------------------------------------------------------- no vacuous verdict

test("wiring gate: a fully wired tree exits 0 (the gate is not always red)", () => {
  const root = fixture(["tests/a.test.mjs", "scripts/g.test.mjs"], {
    test: "node --test tests/a.test.mjs scripts/g.test.mjs",
  });
  const run = runGate(root);
  assert.equal(run.code, 0, run.stdout);
  assert.equal(run.stdout.includes("OK: every test file is wired"), true);
});

test("wiring gate: node_modules is never scanned for orphans", () => {
  const root = fixture(["tests/a.test.mjs", "node_modules/dep/x.test.mjs"], {
    test: "node --test tests/a.test.mjs",
  });
  assert.deepEqual(listTestFiles(root), ["tests/a.test.mjs"]);
  assert.deepEqual(findProblems(root).orphans, []);
});

test("wiring gate: bad usage exits 2 instead of pretending to pass", () => {
  const run = (() => {
    try {
      execFileSync(process.execPath, [GATE, "--root"], { encoding: "utf8" });
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: error.status, stderr: String(error.stderr) };
    }
  })();
  assert.equal(run.code, 2);
  assert.equal(run.stderr.includes("usage:"), true);
});
