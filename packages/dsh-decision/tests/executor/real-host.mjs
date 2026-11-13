import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Real DSH tool-executor host (PLAN-0779 T2.4).
 *
 * Boots the production stack - cordis Context + @deepseek-ai/dsh-tools ToolsService
 * + dsh-system-prompt + the native executor - under plain node, then registers the
 * six DSD tools through the real `tools.register()` face. Nothing here replays the
 * executor: validation, dispatch, and output-schema checks all belong to dsh-tools.
 *
 * The host packages are extracted by the evidence procedure (PLAN-0779 evidence,
 * T2.4 section) because the installed DSH ships them inside an Electron archive
 * that plain node cannot read. Resolution order:
 *   1. env DSD_EXECUTOR_HOST  (a directory that contains node_modules/)
 *   2. the workspace checkout default <one>/.tmp/xh/dsd-executor-host (5 levels up)
 * When no host is present every test in this directory skips loudly - a missing
 * host must never read as a green matrix.
 */

const DEFAULT_HOST = fileURLToPath(new URL("../../../../../.tmp/xh/dsd-executor-host/node_modules/", import.meta.url));

export function hostRoot() {
  // An explicit DSD_EXECUTOR_HOST is authoritative: falling back to the default
  // would hide a misconfigured host behind a silently different one.
  const candidates = process.env.DSD_EXECUTOR_HOST ? [process.env.DSD_EXECUTOR_HOST] : [DEFAULT_HOST];
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[\\/]+$/, "");
    const nm = trimmed.endsWith("node_modules") ? trimmed : join(trimmed, "node_modules");
    if (existsSync(join(nm, "@deepseek-ai", "dsh-tools", "lib", "index.js"))) return nm;
  }
  return null;
}

export const HOST_SKIP =
  "skip: real DSH executor host not found (set DSD_EXECUTOR_HOST; see PLAN-0779 evidence T2.4 for the extraction command)";

async function importFrom(nm, pkg) {
  return import(pathToFileURL(join(nm, pkg, "lib", "index.js")).href);
}

/**
 * Boot the real executor and return a `call` helper plus a dispose.
 * `register` receives the real ToolsService instance AND the host's real
 * `defineTool` compiler; DSD passes
 * `(tools, defineTool) => registerDecisionTools(tools, deps, defineTool)`.
 * The compiler is injected (not imported by src) because the host-provided
 * version is not the one published on npm - see README.
 */
export async function bootRealExecutor(register) {
  const nm = hostRoot();
  if (nm === null) throw new Error("real DSH executor host not found");
  const [{ Context }, toolsMod, promptMod, nativeMod] = await Promise.all([
    importFrom(nm, "@deepseek-ai/cordis"),
    importFrom(nm, "@deepseek-ai/dsh-tools"),
    importFrom(nm, "@deepseek-ai/dsh-system-prompt"),
    importFrom(nm, "@deepseek-ai/dsh-tool-executor-native"),
  ]);
  const app = new Context();
  await app.plugin(promptMod.SystemPrompt);
  await app.plugin(toolsMod.ToolsService);
  await app.plugin({ name: nativeMod.name, inject: nativeMod.inject, apply: nativeMod.apply });
  register(app.tools, toolsMod.defineTool);
  let seq = 0;
  /** Run one model-shaped call through the real batch executor. */
  async function call(name, args, agent) {
    const id = "call-" + ++seq;
    const batch = await app.tools.execute({
      calls: [{ id, name, arguments: JSON.stringify(args ?? {}) }],
      signal: new AbortController().signal,
      ...(agent === undefined ? {} : { agent }),
    });
    const item = batch.results.find((entry) => entry.callId === id) ?? batch.results[0];
    const result = item.result;
    return {
      isError: result.isError === true,
      value: result.value === undefined ? undefined : JSON.parse(JSON.stringify(result.value)),
      error: result.error,
      content: result.content,
    };
  }
  return {
    call,
    tools: app.tools,
    async dispose() {
      await app.fiber.dispose();
    },
  };
}
