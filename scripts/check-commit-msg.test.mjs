import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkMessage, width, DEFAULT_LIMITS } from "./check-commit-msg.mjs";

/**
 * task-29 self-test. "没有夹具的门等于没人信的门" (Lead, 2026-11-15): the gate's
 * judgements below are pinned to real messages from this repo's history, and the last
 * fixture is a mutation — pad the width bound to 200 and the 73-column case MUST go
 * green. That is the difference between "the check runs" and "the check happens to be
 * green today".
 */

const GATE = fileURLToPath(new URL("./check-commit-msg.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
/** Real A12 subject, 73 columns wide (`e0a1cbbc`): the exact case that was over the line. */
const WIDE_73 = "fix(dsd): 附记侧插不再顶替 current，且并入时不再重复正文（task-491 回归）";
const GOOD = "feat(dsd): 加提交信息门禁并接入既有守卫（task-29）";

function runCli(args, options = {}) {
  const res = spawnSync(process.execPath, [GATE, ...args], { cwd: options.cwd ?? REPO, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function withMessageFile(t, message) {
  const dir = mkdtempSync(join(tmpdir(), "a12-commit-msg-"));
  const file = join(dir, "msg.txt");
  writeFileSync(file, message, "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test("a compliant message passes: type(scope), width under the bound, task reference", (t) => {
  const file = withMessageFile(t, `${GOOD}\n\n改动: scripts/check-commit-msg.mjs\n读数: 20 笔跑红 1 笔\n`);
  const res = runCli(["--file", file]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /\[PASS\]/);
  const judged = checkMessage(GOOD);
  assert.deepEqual(judged.errors, []);
  assert.deepEqual(judged.warns, [], "task-NNN counts as a reference");
});

test("a 73-column subject is blocked (the real historical case, CJK counted as 2)", (t) => {
  assert.equal(width(WIDE_73), 73, "fixture pinned to the real measured width");
  assert.ok(73 > DEFAULT_LIMITS.subjectMax, "fixture must actually be over the bound");
  const file = withMessageFile(t, WIDE_73 + "\n");
  const res = runCli(["--file", file]);
  assert.equal(res.status, 1, "over-width blocks");
  assert.match(res.stdout, /E_SUBJECT_TOO_WIDE/);
  const judged = checkMessage(WIDE_73);
  assert.deepEqual(judged.errors.map((e) => e.code), ["E_SUBJECT_TOO_WIDE"]);
});

test("a subject without the type prefix is blocked", () => {
  const judged = checkMessage("加了点东西\n");
  assert.deepEqual(judged.errors.map((e) => e.code), ["E_SUBJECT_FORMAT"]);
});

test("a type outside the A12 set is blocked, and the set is the repo's own five + style", () => {
  const judged = checkMessage("wip(dsd): 先存一下\n");
  assert.deepEqual(judged.errors.map((e) => e.code), ["E_BAD_TYPE"]);
  for (const type of ["feat", "fix", "docs", "test", "chore", "style"]) {
    assert.equal(checkMessage(`${type}(dsd): 说明（task-1）`).errors.length, 0, type + " accepted");
  }
});

test("a missing reference is only a warning: the gate stays green (4 of the last 20 real commits have none)", (t) => {
  const MR = "docs(dsd): 回填交付 sha（38e03f5e）";
  const judged = checkMessage(MR + "\n");
  assert.deepEqual(judged.errors, [], "no reference must not block");
  assert.deepEqual(judged.warns.map((w) => w.code), ["W_NO_REF"]);
  const file = withMessageFile(t, MR + "\n");
  assert.equal(runCli(["--file", file]).status, 0, "warn-only stays exit 0");
});

test("unknown arguments fail closed with exit 2 and usage (never a silent pass)", () => {
  const bad = runCli(["--rang", "HEAD"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /未知参数: --rang/);
  assert.match(bad.stderr, /用法:/);
  // The old one/scripts style (argv.includes) would have ignored this and printed PASS.
  const missingValue = runCli(["--file"]);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /参数缺值/);
  assert.equal(runCli(["--file", "does-not-exist.txt"]).status, 2, "unreadable file is fail-closed");
});

test("MUTATION: raising the width bound to 200 turns the 73-column case green", () => {
  // Same message, same code path, different bound. If this fixture ever passes with the
  // default bound too, the width judgement has stopped running — that is the red flag.
  assert.equal(checkMessage(WIDE_73).errors.length, 1, "default bound blocks it");
  const mutated = checkMessage(WIDE_73, { subjectMax: 200, mergeMax: 100 });
  assert.deepEqual(mutated.errors, [], "with a 200-column bound the same message passes");
  assert.equal(mutated.width, 73, "still the same measured width — only the bound moved");
});

test("merge subjects get the wider bound, and the default is a single HEAD commit", () => {
  // 76 columns: over the normal bound, under the merge bound (git's own summary of a
  // real merge is long by construction, so this bound must not pretend otherwise).
  const mergeSubject = "Merge branch 'feat/" + "x".repeat(45) + "' into main";
  assert.ok(width(mergeSubject) > DEFAULT_LIMITS.subjectMax, "fixture is over the normal bound");
  assert.ok(width(mergeSubject) <= DEFAULT_LIMITS.mergeMax, "but under the merge bound");
  assert.deepEqual(checkMessage(mergeSubject).errors, []);
  const head = runCli(["--json"]);
  assert.equal(head.status, 0, "HEAD commit of this repo passes");
  const parsed = JSON.parse(head.stdout);
  assert.equal(parsed.rows.length, 1, "default checks exactly one commit, never root..HEAD");
});
