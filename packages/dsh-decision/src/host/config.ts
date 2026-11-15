import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteDecisionStore, validateDatabasePath } from "../storage/sqlite-store.ts";
import type { DecisionHostSurfaces } from "./register.ts";

/**
 * Host Config contract for the DSD plugin.
 *
 * The frozen contract (PLAN-0769 `spec/decision-contract.md` §1) requires one
 * explicit, non-empty, absolute SQLite file path per Profile. **The plugin code
 * has no default and never falls back** to the shared `$DSH_HOME` or
 * `process.cwd()`; the shipped default (`<profile>/decision.sqlite`) is declared
 * in the package's `cordis.patch.yml` as `config.databasePath` and can be
 * overridden per Profile (task-157). A missing, empty, relative, or `:memory:`
 * path is refused before any write. The parent directory is never created by the
 * plugin.
 *
 * Contract SSOT: plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md
 * (path-clause supplement, same wording as this comment:
 * packages/dsh-decision/spec/decision-contract.md). Change the file first.
 */
export const Config = z.object({
  databasePath: z.string().min(1).required(),
});

export interface DecisionPluginConfig {
  databasePath: string;
}

/**
 * task-147：把「缺 databasePath」从**一句字段缺失**变成**可照做的一段话**。
 *
 * <p>为什么不是给默认值：本插件的路径是**显式契约**（PLAN-0769 冻结；文件头第 12-16 行）——
 * 缺省到底写哪里只能靠猜，而猜错就是把用户数据写进插件包或 `node_modules`（那两处由
 * `assertOutsidePackage` 拒绝）。所以保持 `required()`，把「怎么填」说清楚。</p>
 *
 * <p>触发场景（实测）：profile 里只 `insert` 了 id/name 而没给 config ⇒ 启用时报
 * `Invalid decision plugin Config: $.databasePath missing required value`，
 * 用户看不出该填什么形态、填在哪。这段就是补这个缺口。</p>
 */
function configHelp(): string {
  return [
    "",
    "The decision plugin needs an explicit SQLite file path and has NO default:",
    "a missing path would mean guessing where your decisions live.",
    "Fix: override the bundle entry in your profile patch (cordis.patch.yml), e.g.",
    "  - id: dsh-decision",
    '    name: "@cc01cc/dsh-decision"',
    "    config:",
    '      databasePath: "<absolute path to a .sqlite file>"',
    "Constraints: absolute path; a file path (not an existing directory); not inside node_modules",
    "or the plugin package; not :memory:. The parent directory must already exist.",
  ].join("\n");
}

/** Package root of the plugin, resolved from this module's own location. */
function packageRootPath(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
}

function hasNodeModulesSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment.toLowerCase() === "node_modules");
}

function assertOutsidePackage(databasePath: string): void {
  const root = resolve(packageRootPath());
  const candidate = resolve(databasePath);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (candidate === root || candidate.startsWith(prefix)) {
    throw new TypeError("databasePath must not point inside the plugin package; a Profile database is user data.");
  }
  if (hasNodeModulesSegment(candidate)) {
    throw new TypeError("databasePath must not point inside node_modules.");
  }
}

/**
 * Validate raw plugin Config and return the accepted absolute database path.
 *
 * Order: Schemastery schema (required non-empty string) → storage fail-closed
 * gate (absolute, not `:memory:`, drive-qualified on Windows) → target-shape
 * checks (not an existing directory) → package/`node_modules` exclusion.
 * Throws `TypeError` on every rejection; callers must not continue on failure.
 */
export function resolveDatabasePath(input: unknown): string {
  // The Schemastery schema validates untrusted input at this boundary, so the
  // declared parameter type (object shape) cannot describe a raw `unknown`.
  const validate = Config as unknown as (value: unknown) => DecisionPluginConfig;
  let config: DecisionPluginConfig;
  try {
    config = validate(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid decision plugin Config: ${reason}${configHelp()}`);
  }

  const databasePath = validateDatabasePath(config.databasePath);
  if (existsSync(databasePath) && statSync(databasePath).isDirectory()) {
    throw new TypeError("databasePath must be a SQLite file path, not an existing directory.");
  }
  assertOutsidePackage(databasePath);
  return databasePath;
}

/** Open the Profile store described by plugin Config; throws on any refusal. */
export function openConfiguredStore(input: unknown): SQLiteDecisionStore {
  return SQLiteDecisionStore.open({ databasePath: resolveDatabasePath(input) });
}

const storesByContext = new WeakMap<Context, SQLiteDecisionStore>();

/**
 * Read the store owned by this plugin context.
 *
 * Later faces (Agent tools, Remote, Client) resolve the same handle through
 * this accessor instead of opening a second connection to the same file.
 */
export function getDecisionStore(ctx: Context): SQLiteDecisionStore {
  const store = storesByContext.get(ctx);
  if (store === undefined) throw new Error("The decision plugin is not loaded on this context.");
  return store;
}

/**
 * Host services the plugin waits for before cordis runs apply.
 *
 * Names verified against the installed Host runtime (0.2.2-rc.1):
 * ToolsService provides "tools"; AgentRegistry calls super(ctx, "agents")
 * (dsh-agent lib/index.js:450); UserQuestionService calls
 * super(ctx, "userQuestions") (dsh-user-questions lib/index.js:492).
 * Declaring them here is what makes the registration timing safe: cordis
 * defers apply until all three exist, so apply never sees a half-ready Host
 * (the task-314 probe's ctx.get-at-apply race cannot happen on this path).
 */
export const inject = ["tools", "agents", "userQuestions"];

/**
 * Host plugin entry.
 *
 * Fails closed: an invalid Config throws during load (before any business
 * read/write), and the connection is closed when the plugin unloads. When the
 * Host surfaces are present, the six Agent tools are registered through the
 * Host-provided defineTool (task-404); registration errors reject the load.
 */
export function apply(ctx: Context, config: unknown): void | Promise<void> {
  const databasePath = resolveDatabasePath(config);
  ctx.effect(() => {
    const store = SQLiteDecisionStore.open({ databasePath });
    storesByContext.set(ctx, store);
    return () => {
      storesByContext.delete(ctx);
      store.close();
    };
  }, "dsh-decision store");
  const surfaces = ctx as unknown as Partial<DecisionHostSurfaces>;
  if (surfaces.tools === undefined || surfaces.agents === undefined || surfaces.userQuestions === undefined) {
    // Minimal contexts (the L0 unit fixtures) carry only the store lifecycle.
    // Under the real Host, `inject` above guarantees all three surfaces before
    // cordis calls apply, so this branch never skips registration there.
    return;
  }
  return import("./register.ts").then(({ registerDecisionToolsWithHost }) =>
    registerDecisionToolsWithHost(surfaces as DecisionHostSurfaces, () => getDecisionStore(ctx)),
  );
}
