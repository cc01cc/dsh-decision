/**
 * Composition root: mount the six decision tools on the real Host surfaces
 * (task-404 / D-1245①).
 *
 * Loaded only through the dynamic import in config.ts's apply() once the Host
 * surfaces exist — never by the L0 unit fixtures, which keep zero DSH
 * dependencies. The Host tools package is imported through a non-literal
 * specifier on purpose: the npm published version (0.0.1-rc.1) is NOT the Host
 * runtime version (0.2.2-rc.1), so a static import would fail resolution on a
 * fresh checkout and could bind the wrong copy (PLAN-0779 T2.4 evidence /
 * D-1238). Resolution follows the mounted plugin location; the R1 mount links
 * the Host's own copy, and the version gate below fails closed on any
 * mismatch instead of registering against an unknown compiler.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptAgentRegistry } from "./caller.ts";
import { createQuestionAsker, type UserQuestionsSurface } from "./question-asker.ts";
import { registerDecisionTools, type DecisionToolStore, type ToolCompiler } from "./tools.ts";

/** Host surfaces the composition root consumes; cordis `inject` guarantees all three. */
export interface DecisionHostSurfaces {
  readonly tools: { register(definition: unknown): unknown };
  /** Raw `ctx.agents`; the registry shape varies across the 0.2.2 rc line (task-9). */
  readonly agents: unknown;
  readonly userQuestions: UserQuestionsSurface;
}

/** The Host tools package and the runtime line this plugin is wired against. */
export const HOST_TOOLS_PACKAGE = "@deepseek-ai/dsh-tools";

/**
 * The Host tools **runtime line** this plugin compiles against (task-167).
 *
 * <p>为什么是「线」不是「点」：原先把 `0.2.2-rc.1` 写死，运行时升到 `0.2.2-rc.3` 就整包拒绝加载
 * —— rc 号是同一编译面内的发布计数，不是 API 断代点。判据因此定为：`major.minor.patch`
 * **必须完全相等**，预发布标签（`rc`/`beta`…）**必须相同**；rc 序号可不同。</p>
 *
 * <p>这样 fail-closed 仍然有效：`0.2.3-rc.1`、`0.3.0`、`0.2.1`、乱码版本一律拒绝（见单测），
 * 只是不再因为「rc 序号变了」把整个插件挡在门外。</p>
 */
export const HOST_TOOLS_VERSION_LINE = "0.2.2";

/** Compare a resolved `dsh-tools` version against the wired runtime line; `true` when compatible. */
export function isCompatibleHostToolsVersion(resolvedVersion: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/u.exec(resolvedVersion.trim());
  if (parsed === null) return false;
  const base = `${parsed[1]}.${parsed[2]}.${parsed[3]}`;
  if (base !== HOST_TOOLS_VERSION_LINE) return false;
  // Any prerelease tag is accepted only when it is the `rc` line; a plain release is the same compile surface.
  return parsed[4] === undefined || parsed[4] === "rc";
}

/**
 * Register the six tools with the Host-provided compiler.
 *
 * Every refusal throws: a missing defineTool or a version mismatch must fail
 * the plugin load, never degrade to raw (uncompiled) registration — that is
 * the exact defect D-1238 fixed.
 */
export async function registerDecisionToolsWithHost(
  surfaces: DecisionHostSurfaces,
  openStore: () => DecisionToolStore,
): Promise<void> {
  // Non-literal specifier: keeps the optional Host peer out of static module
  // resolution (see the module doc).
  const specifier = HOST_TOOLS_PACKAGE;
  const hostTools = (await import(specifier)) as { defineTool?: unknown };
  const defineTool = hostTools.defineTool;
  if (typeof defineTool !== "function") {
    throw new Error(`${HOST_TOOLS_PACKAGE} did not provide defineTool; refusing to register uncompilable tools.`);
  }
  const resolved = fileURLToPath(import.meta.resolve(specifier));
  const manifestPath = join(dirname(resolved), "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  const resolvedVersion = typeof manifest.version === "string" ? manifest.version : "";
  if (!isCompatibleHostToolsVersion(resolvedVersion)) {
    throw new Error(
      `${HOST_TOOLS_PACKAGE} resolved to version ${String(manifest.version)} at ${resolved}; ` +
        `expected the Host runtime line ${HOST_TOOLS_VERSION_LINE} (any rc). Refusing to register against a mismatched compiler.`,
    );
  }
  registerDecisionTools(
    surfaces.tools,
    {
      agents: adaptAgentRegistry(surfaces.agents),
      openStore,
      asker: createQuestionAsker(surfaces.userQuestions),
    },
    defineTool as ToolCompiler,
  );
}

// 注：`lib/` 是 tsc 的生成物，**不要手改** —— tsc 的增量构建按内容判定，改了生成物又被跳过
// 重新生成时，残留会一直留在包里（task-167 实测）。要加临时探针就改源码再 build，用完改回来。
