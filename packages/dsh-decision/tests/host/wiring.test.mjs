/**
 * Real-Host wiring matrix for the composition root (task-404 / D-1245①).
 *
 * Boots the production cordis + ToolsService + native executor stack (same
 * extracted Host as tests/executor), mounts the DSD plugin module through
 * cordis itself, and proves the two risks the card names with real runs:
 *   1. inject timing — apply is deferred until tools+agents+userQuestions all
 *      exist, then the six tools appear; no ctx.get-at-apply race.
 *   2. defineTool provenance — the compiler resolves to the Host runtime copy
 *      (the 0.2.2 line), never the npm published 0.0.1-rc.1.
 * Plus end-to-end calls through the wired plugin, the first-binding question
 * flow over the Host userQuestions surface, and unload semantics.
 *
 * Missing Host ⇒ every test skips loudly (a missing host is never green).
 * The dsh-tools junction under the package node_modules is R1 mount setup;
 * without it the dynamic import cannot resolve and the tests skip with the
 * recovery hint.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostRoot, HOST_SKIP } from "../executor/real-host.mjs";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";

const nm = hostRoot();
const SKIP = nm === null
  ? HOST_SKIP
  : (() => {
      try {
        // The plugin's dynamic import resolves from the package root; mirror
        // that resolution here so a missing junction skips instead of hanging.
        import.meta.resolve("@deepseek-ai/dsh-tools");
        return null;
      } catch {
        return "skip: @deepseek-ai/dsh-tools not resolvable from the package (R1 setup: junction node_modules/@deepseek-ai/dsh-tools to the extracted Host copy)";
      }
    })();

function maybe(name, fn) {
  if (SKIP !== null) {
    test(name, (t) => t.skip(SKIP));
    return;
  }
  test(name, fn);
}

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-wiring-"));
  tempRoots.add(root);
  return root;
}

async function importFrom(pkg) {
  return import(pathToFileURL(join(nm, pkg, "lib", "index.js")).href);
}

/** The production tool stack, without any DSD registration. */
async function bootHost() {
  const [{ Context }, toolsMod, promptMod, nativeMod] = await Promise.all([
    importFrom("@deepseek-ai/cordis"),
    importFrom("@deepseek-ai/dsh-tools"),
    importFrom("@deepseek-ai/dsh-system-prompt"),
    importFrom("@deepseek-ai/dsh-tool-executor-native"),
  ]);
  const app = new Context();
  await app.plugin(promptMod.SystemPrompt);
  await app.plugin(toolsMod.ToolsService);
  await app.plugin({ name: nativeMod.name, inject: nativeMod.inject, apply: nativeMod.apply });
  return app;
}

function liveAgent(id) { return { id, session: { id } }; }

function registryOf(rootAgents) {
  const byId = new Map(rootAgents.map((agent) => [agent.id, agent]));
  return { get: (id) => byId.get(id), roots: () => rootAgents };
}

/** Host-shaped userQuestions surface: answers with the seeded project label. */
function fakeUserQuestions(label) {
  return {
    requests: [],
    async ask(request) {
      this.requests.push(request);
      const question = request.questions[0];
      const option = (question.options ?? []).find((entry) => entry.label === label) ?? (question.options ?? [])[0];
      return { answers: [{ id: question.id, selected: option === undefined ? [] : [option.label] }] };
    },
    async askTimed(request, _callId, _timeoutMs) { return this.ask(request); },
  };
}

function decisionToolNames(app) {
  return app.tools.schemas().map((entry) => entry.name).filter((name) => name.startsWith("decision_"));
}

const SIX = ["decision_search", "decision_get", "decision_create", "decision_create_batch", "decision_update", "decision_void"];

/** Bounded readiness probe for the async registration tail (no fixed sleep). */
async function untilRegistered(app, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (decisionToolNames(app).length === 6) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("decision tools did not register within " + timeoutMs + "ms");
}

/** One model-shaped call through the real batch executor. */
function caller(app) {
  let seq = 0;
  return async (name, args, agent) => {
    const id = "wire-call-" + ++seq;
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
    };
  };
}

/**
 * Mount the plugin on a fresh Host with the given surfaces. Returns the fiber
 * plus the pieces each test asserts on. `bind: true` pre-seeds a project and
 * binding through a second connection; `bind: false` leaves the session
 * unbound so the first call must go through the question card.
 */
async function bootWired(t, { bind }) {
  const app = await bootHost();
  const root = tempRoot();
  const databasePath = join(root, "decisions.sqlite");
  const agent = liveAgent("s-wire");
  const uq = fakeUserQuestions("Wire 项目 · wire");
  const dsd = await import("../../src/host/config.ts");
  const fiber = app.plugin(dsd, { databasePath });
  app.provide("agents", registryOf([agent]));
  app.provide("userQuestions", uq);
  await fiber;
  await untilRegistered(app);
  let seed = null;
  let projectId = null;
  if (bind) {
    seed = SQLiteDecisionStore.open({ databasePath });
    const made = seed.createProject({ name: "Wire 项目", projectKey: "wire" });
    assert.equal(made.ok, true, "seed project");
    projectId = made.data.projectId;
    const bound = seed.bindSession("s-wire", projectId);
    assert.equal(bound.ok, true, "seed binding");
  }
  t.after(async () => {
    if (seed !== null) seed.close();
    await app.fiber.dispose();
  });
  return { app, fiber, call: caller(app), agent, uq, databasePath, seed, projectId };
}

// ------------------------------------------------------- risk 1: inject timing

maybe("wiring: inject defers apply until tools+agents+userQuestions all exist", async (t) => {
  const app = await bootHost();
  t.after(() => app.fiber.dispose());
  const databasePath = join(tempRoot(), "decisions.sqlite");
  const dsd = await import("../../src/host/config.ts");
  const fiber = app.plugin(dsd, { databasePath });
  // tools is up, agents/userQuestions are not: apply must not have run.
  assert.equal(existsSync(databasePath), false, "no store before all surfaces exist");
  assert.deepEqual(decisionToolNames(app), [], "no decision tools before all surfaces exist");
  app.provide("agents", registryOf([liveAgent("s-wire")]));
  assert.equal(existsSync(databasePath), false, "still deferred while userQuestions is missing");
  assert.deepEqual(decisionToolNames(app), [], "still no tools while userQuestions is missing");
  app.provide("userQuestions", fakeUserQuestions("Wire 项目 · wire"));
  await fiber;
  await untilRegistered(app);
  assert.equal(existsSync(databasePath), true, "store opened once every surface exists");
  assert.deepEqual(decisionToolNames(app).sort(), [...SIX].sort(), "six tools after services arrive");
});

// ------------------------------------------------------- risk 2: defineTool provenance

maybe("wiring: defineTool resolves to the Host runtime copy on the 0.2.2 line", async () => {
  const resolved = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-tools"));
  assert.equal(resolved.startsWith(nm), true, "resolved inside the extracted Host tree: " + resolved);
  const manifest = JSON.parse(readFileSync(join(dirname(resolved), "..", "package.json"), "utf8"));
  // task-9: the extracted Host moved from rc.1 to rc.3; task-167 (D-1238) had
  // already moved the gate from a pinned rc point to the runtime line. Use the
  // same line predicate as register.ts — provenance (Host copy, never the npm
  // published 0.0.1-rc.1) stays asserted, no second pinned constant.
  const { isCompatibleHostToolsVersion } = await import("../../src/host/register.ts");
  assert.equal(isCompatibleHostToolsVersion(manifest.version), true, "Host runtime line, not npm 0.0.1-rc.1: " + manifest.version);
});

// ------------------------------------------------------- end-to-end through the plugin

maybe("wiring: six tools callable through the real executor after plugin mount", async (t) => {
  const { call, agent } = await bootWired(t, { bind: true });
  const made = await call("decision_create", { decision: "接线验证决策", summary: "wiring" }, agent);
  assert.equal(made.isError, false, "create not refused");
  assert.equal(made.value.ok, true, "create envelope");
  const got = await call("decision_get", { decisionId: made.value.data.decisionId }, agent);
  assert.equal(got.value.ok, true, "get envelope");
  assert.equal(got.value.data.decision, "接线验证决策", "roundtrip through the wired store");
  const listed = await call("decision_search", {}, agent);
  assert.equal(listed.value.ok, true, "default list envelope");
  assert.equal(listed.value.data.decisions.length, 1, "default list sees the row");
});

maybe("wiring: caller gate refuses a missing caller through the wired tools", async (t) => {
  const { call } = await bootWired(t, { bind: true });
  const refused = await call("decision_search", {}, undefined);
  assert.equal(refused.isError, true, "registry-level refusal");
  assert.equal(refused.value, undefined, "no domain envelope for a caller refusal");
});

maybe("wiring: first call asks through the Host userQuestions surface and binds", async (t) => {
  const { call, agent, uq, seed, databasePath } = await bootWired(t, { bind: false });
  // Seed the project the question card will offer, without binding the session.
  const own = SQLiteDecisionStore.open({ databasePath });
  t.after(() => own.close());
  const made = own.createProject({ name: "Wire 项目", projectKey: "wire" });
  assert.equal(made.ok, true, "seed project");
  const first = await call("decision_create", { decision: "首次绑定决策" }, agent);
  assert.equal(first.isError, false, "first call not refused");
  assert.equal(first.value.ok, true, "first call envelope");
  assert.equal(uq.requests.length, 1, "exactly one question card");
  assert.equal(uq.requests[0].agent, agent, "question carries the live caller");
  const second = await call("decision_create", { decision: "第二条决策" }, agent);
  assert.equal(second.value.ok, true, "second call envelope");
  assert.equal(uq.requests.length, 1, "no re-ask once the session is bound");
  assert.equal(seed, null, "fixture stayed unbound");
});

// ------------------------------------------------------- unload semantics

maybe("wiring: unload unregisters the six tools and keeps the data durable", async (t) => {
  const { app, fiber, call, agent, databasePath } = await bootWired(t, { bind: true });
  const made = await call("decision_create", { decision: "卸载前写入" }, agent);
  assert.equal(made.value.ok, true, "pre-dispose write");
  await fiber.dispose();
  assert.deepEqual(decisionToolNames(app), [], "tools unregistered with the plugin fiber");
  const reopened = SQLiteDecisionStore.open({ databasePath });
  t.after(() => reopened.close());
  const page = reopened.searchDecisions(1, {});
  assert.equal(page.ok, true, "reopen search");
  assert.equal(page.data.decisions.length, 1, "data durable after unload");
  assert.equal(page.data.decisions[0].preview, "卸载前写入", "row content preserved (search preview = decision text when no summary)");
});

// ------------------------------------- task-9: rc.3 registry shape (real class)

maybe("wiring: rc.3 AgentRegistry — root admitted, delegated refused through the real executor", async (t) => {
  // task-9 / D-1651 / D-1657: the rc.3 Host AgentRegistry exposes get(id)+list()
  // (roots() was removed). Mount the plugin against the REAL registry class and
  // prove the composition-root adapter preserves the gate end to end. Fixture
  // headers are the host's own facts: childSessionMeta writes origin:"subagent"
  // + delegationDepth for every child (dsh-subagent lib/index.js; exact source
  // quoted in the task-9 evidence pack).
  const agentMod = await importFrom("@deepseek-ai/dsh-agent");
  const app = await bootHost();
  app.provide("sessionProjections", { register: async (def) => ({ stateOf: () => def.init() }) });
  await app.plugin(agentMod.AgentRegistry);
  const root = { id: "s-rc3-root", session: { id: "s-rc3-root", header: { origin: "user" } }, options: {} };
  const child = { id: "s-rc3-child", session: { id: "s-rc3-child", header: { origin: "subagent", delegationDepth: 1 } }, options: {} };
  app.agents.enter(root);
  app.agents.enter(child);
  assert.equal(app.agents.get("s-rc3-root"), root, "real registry get returns the exact instance");
  assert.equal(typeof app.agents.roots, "undefined", "rc.3 registry has no roots() — the adapter must supply it");
  const databasePath = join(tempRoot(), "decisions.sqlite");
  app.provide("userQuestions", fakeUserQuestions("RC3 项目 · rc3"));
  const dsd = await import("../../src/host/config.ts");
  const fiber = app.plugin(dsd, { databasePath });
  await fiber;
  await untilRegistered(app);
  const seed = SQLiteDecisionStore.open({ databasePath });
  const made = seed.createProject({ name: "RC3 项目", projectKey: "rc3" });
  assert.equal(made.ok, true, "seed project");
  assert.equal(seed.bindSession("s-rc3-root", made.data.projectId).ok, true, "bind root");
  assert.equal(seed.bindSession("s-rc3-child", made.data.projectId).ok, true, "bind child");
  seed.close();
  t.after(() => app.fiber.dispose());
  const call = caller(app);
  const asRoot = await call("decision_search", {}, root);
  assert.equal(asRoot.isError, false, "root caller passes the adapted gate");
  assert.equal(asRoot.value.ok, true, "root search envelope");
  const asChild = await call("decision_search", {}, child);
  assert.equal(asChild.isError, true, "delegated caller refused at registry level");
  assert.equal(asChild.value, undefined, "no domain envelope for a caller refusal");
  const noCaller = await call("decision_search", {}, undefined);
  assert.equal(noCaller.isError, true, "missing caller still refused");
});
