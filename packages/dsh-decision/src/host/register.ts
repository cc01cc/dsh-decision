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
import type { LiveAgentRegistry } from "./caller.ts";
import { createQuestionAsker, type UserQuestionsSurface } from "./question-asker.ts";
import { registerDecisionTools, type DecisionToolStore, type ToolCompiler } from "./tools.ts";

/** Host surfaces the composition root consumes; cordis `inject` guarantees all three. */
export interface DecisionHostSurfaces {
  readonly tools: { register(definition: unknown): unknown };
  readonly agents: LiveAgentRegistry;
  readonly userQuestions: UserQuestionsSurface;
}

/** The Host tools package and the runtime version this plugin is wired against. */
export const HOST_TOOLS_PACKAGE = "@deepseek-ai/dsh-tools";
export const HOST_TOOLS_VERSION = "0.2.2-rc.1";

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
  if (manifest.version !== HOST_TOOLS_VERSION) {
    throw new Error(
      `${HOST_TOOLS_PACKAGE} resolved to version ${String(manifest.version)} at ${resolved}; ` +
        `expected the Host runtime version ${HOST_TOOLS_VERSION}. Refusing to register against a mismatched compiler.`,
    );
  }
  registerDecisionTools(
    surfaces.tools,
    {
      agents: surfaces.agents,
      openStore,
      asker: createQuestionAsker(surfaces.userQuestions),
    },
    defineTool as ToolCompiler,
  );
}
