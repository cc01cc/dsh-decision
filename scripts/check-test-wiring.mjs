#!/usr/bin/env node
/**
 * Gate: every *.test.mjs in the repository must actually be executed by some
 * package script, and every test file named by a script must exist.
 *
 * Why (2026-11-15, task-84): the root gate read 165/165 green while 4 of 14 test
 * files were in no script at all - and two of those four were red. A green gate
 * only proves that the files it runs are green, so "every test file is wired"
 * has to be checked mechanically instead of remembered.
 *
 * Two fatal classes:
 *   orphan  - a *.test.mjs on disk that no script names => nobody runs it
 *   missing - a *.test.mjs named by a script but absent on disk
 *
 * Usage:
 *   node scripts/check-test-wiring.mjs                check this repository
 *   node scripts/check-test-wiring.mjs --root <dir>   check another tree
 * Exit: 0 clean, 1 problems, 2 usage error.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SUFFIX = ".test.mjs";
const SKIP_DIRS = new Set(["node_modules", ".git", ".tmp", ".tsbuild", ".turbo", "coverage", "dist", "build", "lib"]);
const MAX_DEPTH = 6;

function toPosix(p) {
  return p.split(sep).join("/");
}

/** A script token is a test path once the surrounding quoting is stripped. */
function normalizeToken(token) {
  return token.replace(/^[^A-Za-z0-9._/-]+/, "").replace(/[^A-Za-z0-9._/-]+$/, "");
}

/** Every *.test.mjs under root, repo-relative and sorted. */
export function listTestFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
        found.push(toPosix(relative(root, full)));
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

/** Directories holding a package.json that may own a test script. */
export function listManifestDirs(root) {
  const found = [root];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (existsSync(join(full, "package.json"))) found.push(full);
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * Test paths named by any script, mapped to the "pkg#script" labels naming them.
 * A package-level script runs with that package as cwd, so its paths resolve
 * against the manifest directory rather than the repo root.
 */
export function referencedTests(root) {
  const referenced = new Map();
  for (const manifestDir of listManifestDirs(root)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(manifestDir, "package.json"), "utf8")); } catch { continue; }
    const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
    const dirRel = toPosix(relative(root, manifestDir));
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string") continue;
      for (const rawToken of command.split(/\s+/)) {
        const token = normalizeToken(rawToken);
        if (!token.endsWith(TEST_SUFFIX)) continue;
        const abs = resolve(manifestDir, token);
        const rel = toPosix(relative(root, abs));
        const label = dirRel === "" ? name : dirRel + "#" + name;
        if (!referenced.has(rel)) referenced.set(rel, []);
        const labels = referenced.get(rel);
        if (!labels.includes(label)) labels.push(label);
      }
    }
  }
  return referenced;
}

/** { orphans, missing } - both sorted, both fatal. */
export function findProblems(root) {
  const tests = listTestFiles(root);
  const referenced = referencedTests(root);
  const orphans = tests.filter((file) => !referenced.has(file));
  const missing = [...referenced.keys()].filter((file) => !tests.includes(file)).sort();
  return { tests, orphans, missing, referenced };
}

export function formatProblems(root, problems) {
  const lines = [];
  lines.push("test-wiring: " + problems.tests.length + " test file(s) on disk, " + problems.referenced.size + " named by a script");
  for (const file of problems.orphans) {
    lines.push("ORPHAN  " + file + "  (no package script runs it - add it to a test script)");
  }
  for (const file of problems.missing) {
    const labels = problems.referenced.get(file) || [];
    lines.push("MISSING " + file + "  (named by " + labels.join(", ") + " but absent on disk)");
  }
  if (problems.orphans.length === 0 && problems.missing.length === 0) lines.push("OK: every test file is wired and every wiring target exists");
  return lines.join("\n");
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return "";
  return value;
}

function main(argv) {
  let root = dirname(dirname(fileURLToPath(import.meta.url)));
  const requested = parseRoot(argv);
  if (requested === "") {
    process.stderr.write("usage: node scripts/check-test-wiring.mjs [--root DIR]\n");
    return 2;
  }
  if (requested !== null) root = resolve(requested);
  const problems = findProblems(root);
  process.stdout.write(formatProblems(root, problems) + "\n");
  return problems.orphans.length + problems.missing.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
