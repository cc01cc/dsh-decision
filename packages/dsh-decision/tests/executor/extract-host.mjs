#!/usr/bin/env node
/**
 * Provision the real DSH tool-executor host for the T2.4 matrix (PLAN-0779).
 *
 * The installed DSH ships @deepseek-ai/dsh-tools and friends inside an Electron
 * asar archive that plain node cannot read. This instrument copies the exact
 * dependency closure the executor needs into a plain-node-readable tree, so
 * `node --test tests/executor/executor-matrix.test.mjs` can mount the production
 * stack (cordis + ToolsService + SystemPrompt + native executor) without a
 * package install and without touching any project manifest.
 *
 * Usage:
 *   node tests/executor/extract-host.mjs --dsh-root <dir> [--out <dir>]
 *   DSH_ROOT=<dir> node tests/executor/extract-host.mjs
 *
 * <dir> is a DSH checkout root that contains node_modules/@deepseek-ai/dsh-tools.
 * When the only available tree is the installed asar archive, run this script
 * under a runtime whose fs can read it (the DSH Electron runtime does); the copy
 * itself is plain fs reads/writes. No machine-specific path is baked in here.
 *
 * Default output: <workspace>/.tmp/xh/dsd-executor-host (gitignored), which is
 * also the default resolution target of real-host.mjs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The closure ToolsService + native executor actually import at runtime. */
const PACKAGES = [
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-tool-executor-native",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-util-values",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-util-crypto",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-typert-protocol",
  "@deepseek-ai/cosmokit",
  "zod",
  "@standard-schema/spec",
];

function parseArgs(argv) {
  const out = { dshRoot: process.env.DSH_ROOT, outDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dsh-root") out.dshRoot = argv[++i];
    else if (arg === "--out") out.outDir = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (!arg.startsWith("-") && out.dshRoot === undefined) out.dshRoot = arg;
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

function copyTree(src, dst, tally) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue; // hoisted layout: one shared root
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to, tally);
    else {
      const bytes = readFileSync(from);
      writeFileSync(to, bytes);
      tally.files += 1;
      tally.bytes += bytes.length;
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.dshRoot === undefined) {
  console.log("usage: node tests/executor/extract-host.mjs --dsh-root <dir> [--out <dir>]");
  console.log("       DSH_ROOT=<dir> node tests/executor/extract-host.mjs");
  process.exit(args.help ? 0 : 2);
}

const sourceRoot = resolve(args.dshRoot, "node_modules");
if (!existsSync(join(sourceRoot, "@deepseek-ai", "dsh-tools", "lib", "index.js"))) {
  console.error("E_NO_DSH_TOOLS: " + join(sourceRoot, "@deepseek-ai", "dsh-tools") + " is not readable.");
  console.error("If the tree is an asar archive, run this under a runtime whose fs reads it (DSH Electron).");
  process.exit(2);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const defaultOut = resolve(here, "../../../../../.tmp/xh/dsd-executor-host");
const outRoot = resolve(args.outDir ?? defaultOut);
const destRoot = join(outRoot, "node_modules");

const tally = { files: 0, bytes: 0 };
const versions = {};
const missing = [];
for (const pkg of PACKAGES) {
  const src = join(sourceRoot, ...pkg.split("/"));
  if (!existsSync(src)) { missing.push(pkg); continue; }
  const manifest = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  versions[pkg] = manifest.version;
  copyTree(src, join(destRoot, ...pkg.split("/")), tally);
}

const probe = join(destRoot, "@deepseek-ai", "dsh-tools", "lib", "index.js");
if (!existsSync(probe) || missing.length > 0) {
  console.error("E_INCOMPLETE: missing packages: " + (missing.join(", ") || "(none)"));
  process.exit(1);
}
console.log("[extract-host] source:", sourceRoot);
console.log("[extract-host] dest:  ", destRoot);
console.log("[extract-host] packages:", Object.keys(versions).length, "files:", tally.files, "bytes:", tally.bytes);
for (const [pkg, version] of Object.entries(versions)) console.log("  " + pkg + "@" + version);
console.log("[extract-host] size check:", statSync(probe).size, "bytes in dsh-tools/lib/index.js");
console.log("[extract-host] next: node --test tests/executor/executor-matrix.test.mjs");
