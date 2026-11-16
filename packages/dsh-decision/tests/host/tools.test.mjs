
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";
import {
  DECISION_TOOL_NAMES,
  DecisionToolRefusal,
  createDecisionTools,
  registerDecisionTools,
} from "../../src/host/tools.ts";

/**
 * Six Agent tools L0 (PLAN-0779 T2.1/T2.3).
 *
 * Two properties are asserted structurally rather than by inspection:
 * - ONE outlet: every tool resolves its project through resolveSessionProject,
 *   so none can hold a private binding path. A tool that bypassed the outlet
 *   would not see the project question and could not name the project at all.
 * - ONE refusal shape: the same caller cause yields identical fields from all
 *   six tools (deepEqual), so a Client cannot read one tool as authorized and
 *   another as refused.
 */

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function storeFor(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-tools-"));
  tempRoots.add(root);
  const store = SQLiteDecisionStore.open({ databasePath: join(root, "decisions.sqlite") });
  t.after(() => store.close());
  return store;
}

function registryOf(rootAgents, childAgents = []) {
  const byId = new Map();
  for (const agent of [...rootAgents, ...childAgents]) byId.set(agent.id, agent);
  return { get: (id) => byId.get(id), roots: () => rootAgents };
}

function liveAgent(id) {
  return { id, session: { id } };
}

/** Execution context as the Host passes it (only agent is trusted). */
function execFor(agent, name, args) {
  return { callId: "call-1", name, arguments: args, agent, signal: undefined };
}

/** Askers that script the first-use project question. */
function refusingAsker() {
  return {
    calls: [],
    async ask() { return { kind: "cancelled", reason: "no answer" }; },
    async askTimed() { return { kind: "pending", callId: "c" }; },
  };
}

function chooserFor(label) {
  const asker = {
    calls: [],
    async ask(_agent, prompt) {
      asker.calls.push(prompt.id);
      const option = prompt.options.find((entry) => entry.label === label) ?? prompt.options[0];
      return { kind: "answered", reply: { selected: option === undefined ? [] : [option.label] } };
    },
    async askTimed(_agent, prompt) { return asker.ask(_agent, prompt); },
  };
  return asker;
}

/** Valid arguments for each tool, unused fields irrelevant to the property under test. */
function argsFor(name) {
  if (name === "decision_search") return { query: "x" };
  if (name === "decision_get") return { decisionId: 1 };
  if (name === "decision_create") return { decision: "d" };
  if (name === "decision_create_batch") return { decisions: [{ decision: "d" }] };
  if (name === "decision_update") return { decisionId: 1, expectedRevision: 1, patch: { rationale: "r" } };
  return { decisionId: 1, expectedRevision: 1, reason: "r" };
}

/** Invoke a tool and normalize either a result or a refusal into one record. */
async function invoke(tool, agent, args) {
  try {
    const value = await tool.execute(args, execFor(agent, tool.name, args));
    return { threw: false, value };
  } catch (error) {
    if (error instanceof DecisionToolRefusal) {
      return { threw: true, reason: error.reason, message: error.message, name: error.name };
    }
    return { threw: true, reason: "<other:" + error.name + ">", message: error.message, name: error.name };
  }
}

// ------------------------------------------------------- T2.1 registration

test("T2.1: the six tools register in contract order with distinct names", () => {
  const registered = [];
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  // task-388 (D-1238): the identity compile keeps this stand-in sink correct
  // both before and after registerDecisionTools gains its required compile arg.
  registerDecisionTools({ register: (definition) => registered.push(definition.name) }, deps, (definition) => definition);
  // Contract order: lines 110, 145, 179, 212, 258, 292.
  assert.deepEqual(registered, [
    "decision_search",
    "decision_get",
    "decision_create",
    "decision_create_batch",
    "decision_update",
    "decision_void",
  ]);
  assert.deepEqual(registered, [...DECISION_TOOL_NAMES]);
});

test("T2.1: no tool name collides with a built-in DSH tool name", () => {
  // A duplicate registration name fails hard in the Host, so this set is the
  // built-ins this composition actually ships (verified against the installed
  // @deepseek-ai/* tool packages).
  const BUILT_IN = new Set([
    "bash", "read", "write", "edit", "apply_patch", "read_image", "glob", "grep",
    "todo_write", "present", "skill", "ask_user_question", "web_search", "web_fetch",
    "pwsh", "terminal_open", "terminal_send", "terminal_read", "terminal_signal",
    "terminal_close", "terminal_list", "job_output", "job_list", "job_kill",
    "schedule_create", "schedule_list", "schedule_view", "schedule_edit",
    "session_search", "session_event_search", "session_trace", "session_event_trace",
    "session_event_read", "working_directory", "load_workspace_dependencies",
    "create_goal", "get_goal", "update_goal", "ralph", "create_worktree",
    "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent",
    "wait_agent", "team_task_create", "team_task_list", "team_task_get", "team_task_update",
    "list_subagent_models", "run_code", "str_replace_editor", "cordis_inspect_list",
    "cordis_inspect_query",
  ]);
  for (const name of DECISION_TOOL_NAMES) {
    assert.equal(BUILT_IN.has(name), false, name + " collides with a built-in tool");
  }
});

test("T2.1: each tool's description states its own intent boundary", () => {
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  const byName = new Map(createDecisionTools(deps).map((tool) => [tool.name, tool]));
  // Contract line 88: the write tools' descriptions carry the intent trust boundary.
  for (const name of ["decision_create", "decision_create_batch", "decision_update", "decision_void"]) {
    assert.match(byName.get(name).description, /explicitly ask/i, name);
  }
  // Contract lines 260, 294: read first, pass the revision unchanged, never replay.
  for (const name of ["decision_update", "decision_void"]) {
    assert.match(byName.get(name).description, /decision_get/i, name);
    assert.match(byName.get(name).description, /expectedRevision/i, name);
    assert.match(byName.get(name).description, /REVISION_CONFLICT/i, name);
  }
  // Contract line 112: search points at decision_get for full content.
  assert.match(byName.get("decision_search").description, /decision_get/i);
  // Contract lines 149, 296: get is readable even when voided; void needs a reason.
  assert.match(byName.get("decision_get").description, /voided/i);
  assert.match(byName.get("decision_void").description, /reason/i);
});

// --------------------------------------------------- T2.3 single outlet

test("T2.3: an unbound session is asked once and all six tools then share the project", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const asker = chooserFor("Atlas · atlas");
  const deps = { agents: registryOf([root]), openStore: () => store, asker };
  store.createProject({ name: "Atlas", projectKey: "atlas" });

  const search = createDecisionTools(deps).find((tool) => tool.name === "decision_search");
  const first = await search.execute({ query: "anything" }, execFor(root, "decision_search", { query: "anything" }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(asker.calls.length, 1, "the first call asks the project question exactly once");

  const created = store.createDecision(1, { decision: "Use SQLite." });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.data.decisionId;

  // Each tool is exercised against the revision that exists when it runs, exactly
  // as the contract instructs the model to do (lines 260, 294).
  for (const tool of createDecisionTools(deps)) {
    if (tool.name === "decision_search") continue;
    if (tool.name === "decision_get") {
      const outcome = await invoke(tool, root, { decisionId: id });
      assert.equal(outcome.value.ok, true, "decision_get: " + JSON.stringify(outcome.value));
      continue;
    }
    if (tool.name === "decision_create") {
      const outcome = await invoke(tool, root, { decision: "Another decision." });
      assert.equal(outcome.value.ok, true, "decision_create: " + JSON.stringify(outcome.value));
      continue;
    }
    if (tool.name === "decision_create_batch") {
      const outcome = await invoke(tool, root, { decisions: [{ decision: "Batch decision." }] });
      assert.equal(outcome.value.ok, true, "decision_create_batch: " + JSON.stringify(outcome.value));
      continue;
    }
    // update then void: read the current revision first, as the tools instruct.
    const current = store.getDecision(1, { decisionId: id });
    assert.equal(current.ok, true, JSON.stringify(current));
    const args = tool.name === "decision_update"
      ? { decisionId: id, expectedRevision: current.data.revision, patch: { rationale: "Because." } }
      : { decisionId: id, expectedRevision: current.data.revision, reason: "Superseded." };
    const outcome = await invoke(tool, root, args);
    assert.equal(outcome.value.ok, true, tool.name + ": " + JSON.stringify(outcome.value));
  }
  assert.equal(asker.calls.length, 1, "no tool re-asks once the session is bound");
});

test("T2.3: no tool invents a project when the outlet yields none", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  // A project exists, so skipping the outlet would silently produce a decision write;
  // the refusing asker proves the outlet is the only path.
  const deps = { agents: registryOf([root]), openStore: () => store, asker: refusingAsker() };
  store.createProject({ name: "Atlas", projectKey: "atlas" });

  for (const tool of createDecisionTools(deps)) {
    const outcome = await invoke(tool, root, argsFor(tool.name));
    assert.equal(outcome.threw, false, tool.name);
    assert.equal(outcome.value.ok, false, tool.name + " must not invent a project");
    assert.equal(outcome.value.error.code, "PROJECT_REQUIRED", tool.name);
  }
  assert.equal(store.getBoundProject("session-root").data, null, "nothing was bound");
  assert.equal(store.listProjects().data.length, 1, "no project was created");
});

test("T2.3: another project's decision is indistinguishable from a missing one", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const asker = chooserFor("Atlas · atlas");
  const deps = { agents: registryOf([root]), openStore: () => store, asker };
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  const other = store.createProject({ name: "Borealis", projectKey: "borealis" });
  const foreign = store.createDecision(other.data.projectId, { decision: "Belongs to Borealis." });
  assert.equal(foreign.ok, true, JSON.stringify(foreign));

  const getTool = createDecisionTools(deps).find((tool) => tool.name === "decision_get");
  // Bind to Borealis so the "foreign" decision is in scope, then switch to Atlas:
  // the same id must then read as absent.
  store.bindSession("session-root", other.data.projectId);
  const inScope = await invoke(getTool, root, { decisionId: foreign.data.decisionId });
  assert.equal(inScope.value.ok, true, JSON.stringify(inScope.value));

  // A different session bound to Atlas cannot see Borealis's decision.
  const atlasRoot = liveAgent("session-atlas");
  store.bindSession("session-atlas", store.getProjectByKey("atlas").data.projectId);
  const atlasDeps = { agents: registryOf([root, atlasRoot]), openStore: () => store, asker: refusingAsker() };
  const atlasGet = createDecisionTools(atlasDeps).find((tool) => tool.name === "decision_get");
  const foreignResult = await invoke(atlasGet, atlasRoot, { decisionId: foreign.data.decisionId });
  const missingResult = await invoke(atlasGet, atlasRoot, { decisionId: 999 });

  assert.equal(foreignResult.value.ok, false);
  assert.equal(missingResult.value.ok, false);
  assert.equal(foreignResult.value.error.code, "DECISION_NOT_FOUND");
  assert.equal(missingResult.value.error.code, "DECISION_NOT_FOUND");

  // Pinned against the store's own failure, not just against each other:
  // comparing two tool results would pass even if BOTH leaked the project name.
  const canonical = store.getDecision(store.getProjectByKey("atlas").data.projectId, { decisionId: 999 });
  assert.equal(canonical.ok, false, JSON.stringify(canonical));
  assert.deepEqual(foreignResult.value.error, canonical.error, "a foreign decision must read exactly like a missing one");
  assert.deepEqual(missingResult.value.error, canonical.error, "a missing decision must read exactly like the domain failure");
  // No ownership field may appear at all (contract line 350).
  assert.deepEqual(Object.keys(foreignResult.value.error).sort(), ["code", "message"]);
  assert.equal(foreignResult.value.error.message.includes("Borealis"), false, "the message must not name the owning project");
  assert.equal(foreignResult.value.error.message.includes("Atlas"), false, "the message must not name the current project");
});

// ------------------------------------------- cross-tool refusal consistency

test("T2.3: all six tools refuse the same caller cause with identical fields", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const child = liveAgent("session-child");
  const impostor = liveAgent("session-root");
  const scenarios = [
    ["missing caller", undefined, registryOf([root]), "CALLER_REQUIRED"],
    ["impostor", impostor, registryOf([root]), "CALLER_NOT_LIVE"],
    ["delegated", child, registryOf([root], [child]), "DELEGATED_CALLER"],
  ];

  for (const [label, agent, registry, reason] of scenarios) {
    const deps = { agents: registry, openStore: () => store, asker: refusingAsker() };
    const payloads = [];
    for (const tool of createDecisionTools(deps)) {
      payloads.push({ tool: tool.name, ...(await invoke(tool, agent, argsFor(tool.name))) });
    }
    const refusals = payloads.filter((payload) => payload.threw === true);
    assert.equal(refusals.length, DECISION_TOOL_NAMES.length, label + ": all six must refuse");
    assert.equal(refusals[0].reason, reason, label);
    for (const payload of refusals) {
      assert.deepEqual(
        { reason: payload.reason, message: payload.message, name: payload.name },
        { reason: refusals[0].reason, message: refusals[0].message, name: refusals[0].name },
        label + "/" + payload.tool,
      );
    }
  }
});

test("T2.3: a refused caller never opens the store or asks a question", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  let opened = 0;
  const asker = refusingAsker();
  const deps = { agents: registryOf([root]), openStore: () => { opened += 1; return store; }, asker };
  for (const tool of createDecisionTools(deps)) {
    const outcome = await invoke(tool, undefined, argsFor(tool.name));
    assert.equal(outcome.threw, true, tool.name);
  }
  assert.equal(opened, 0, "no store was opened for a refused caller");
  assert.deepEqual(asker.calls, [], "no question was asked for a refused caller");
});

// -------------------------------------- write tools: >=2 negatives each

test("T2.1: each write tool refuses a missing project and a stale revision without side effects", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const asker = chooserFor("Atlas · atlas");
  const deps = { agents: registryOf([root]), openStore: () => store, asker };
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  const tools = new Map(createDecisionTools(deps).map((tool) => [tool.name, tool]));
  // Bind once through the outlet so the negatives below fail for their own reason,
  // not because the session was unbound.
  await tools.get("decision_search").execute({ query: "x" }, execFor(root, "decision_search", { query: "x" }));
  const seed = store.createDecision(1, { decision: "Seed decision." });
  assert.equal(seed.ok, true, JSON.stringify(seed));
  const id = seed.data.decisionId;

  // Negative 1: no bound project — a session whose binding is absent must be asked,
  // and when the asker refuses the write tool reports PROJECT_REQUIRED and writes nothing.
  const unbound = liveAgent("session-unbound");
  const refusing = refusingAsker();
  const unboundDeps = { agents: registryOf([root, unbound]), openStore: () => store, asker: refusing };
  const unboundTools = new Map(createDecisionTools(unboundDeps).map((tool) => [tool.name, tool]));
  const before = store.searchDecisions(1, { query: "" });
  for (const name of ["decision_create", "decision_create_batch", "decision_update", "decision_void"]) {
    const outcome = await invoke(unboundTools.get(name), unbound, argsFor(name));
    assert.equal(outcome.value.ok, false, name);
    assert.equal(outcome.value.error.code, "PROJECT_REQUIRED", name + " must refuse without a project");
  }
  assert.equal(store.getBoundProject("session-unbound").data, null, "no binding was written");
  assert.deepEqual(store.searchDecisions(1, { query: "" }), before, "no decision was written");

  // Negative 2: stale expectedRevision — refused with no snapshot and no revision bump.
  const current = store.getDecision(1, { decisionId: id });
  const stale = current.data.revision + 7;
  const updateStale = await invoke(tools.get("decision_update"), root, { decisionId: id, expectedRevision: stale, patch: { rationale: "stale" } });
  assert.equal(updateStale.value.ok, false);
  assert.equal(updateStale.value.error.code, "REVISION_CONFLICT");
  const voidStale = await invoke(tools.get("decision_void"), root, { decisionId: id, expectedRevision: stale, reason: "stale" });
  assert.equal(voidStale.value.ok, false);
  assert.equal(voidStale.value.error.code, "REVISION_CONFLICT");
  // Both refusals left the record exactly as it was.
  const after = store.getDecision(1, { decisionId: id });
  assert.equal(after.data.revision, current.data.revision);
  assert.equal(after.data.status, current.data.status);
  assert.deepEqual(store.getDecisionHistory(1, id).data, [], "no snapshot was appended by either refusal");

  // Negative 3: a decision that does not exist — same code/shape as a foreign one.
  for (const name of ["decision_update", "decision_void"]) {
    const outcome = await invoke(tools.get(name), root, name === "decision_update"
      ? { decisionId: 999, expectedRevision: 1, patch: { rationale: "r" } }
      : { decisionId: 999, expectedRevision: 1, reason: "r" });
    assert.equal(outcome.value.ok, false, name);
    assert.equal(outcome.value.error.code, "DECISION_NOT_FOUND", name);
  }
});

// --------------------------------------------------- task-377 tool surface

/** Bind one session to a fresh project and return the six tools plus the agent. */
function boundTools(t, store) {
  const root = liveAgent("session-377");
  const asker = chooserFor("Atlas · atlas");
  const deps = { agents: registryOf([root]), openStore: () => store, asker };
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  store.bindSession("session-377", 1);
  return { root, tools: new Map(createDecisionTools(deps).map((tool) => [tool.name, tool])) };
}

test("T377: decision_create dedupes by externalId and decision_get exposes the new fields", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const first = await invoke(create, root, { decision: "Use SQLite.", externalId: "D-1120", refs: [{ type: "task", id: "T-194" }] });
  assert.equal(first.value.ok, true, JSON.stringify(first.value));
  assert.equal(first.value.data.externalId, "D-1120");
  assert.equal(first.value.data.alreadyExisted, false);

  const repeat = await invoke(create, root, { decision: "Different text.", externalId: "D-1120" });
  assert.equal(repeat.value.ok, true, JSON.stringify(repeat.value));
  assert.equal(repeat.value.data.decisionId, first.value.data.decisionId);
  assert.equal(repeat.value.data.alreadyExisted, true);

  const got = await invoke(tools.get("decision_get"), root, { decisionId: first.value.data.decisionId });
  assert.equal(got.value.ok, true, JSON.stringify(got.value));
  assert.equal(got.value.data.externalId, "D-1120");
  assert.equal(got.value.data.timeHorizon, "long_term", "the tool face defaults to long_term");
  assert.equal(got.value.data.replaces, null);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 1);
});

test("T377: decision_create rejects a reversed bl reference through the tool face", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const reversed = await invoke(tools.get("decision_create"), root, { decision: "wrong direction", refs: [{ type: "bl", id: "BL-584" }] });
  assert.equal(reversed.value.ok, false, JSON.stringify(reversed.value));
  assert.equal(reversed.value.error.code, "VALIDATION_FAILED");
  assert.equal(reversed.value.error.field, "refs");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, 0);
});

test("T377: decision_create_batch re-run dedupes by externalId through the tool face", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const batch = tools.get("decision_create_batch");
  const rows = { decisions: [{ decision: "a", externalId: "D-20" }, { decision: "b", externalId: "D-21" }] };
  const first = await invoke(batch, root, rows);
  assert.equal(first.value.ok, true, JSON.stringify(first.value));
  assert.equal(first.value.data.createdCount, 2);
  const again = await invoke(batch, root, rows);
  assert.equal(again.value.ok, true, JSON.stringify(again.value));
  assert.equal(again.value.data.createdCount, 0);
  assert.deepEqual(again.value.data.decisions.map((d) => d.decisionId), first.value.data.decisions.map((d) => d.decisionId));
  assert.ok(again.value.data.decisions.every((d) => d.alreadyExisted === true));
});

test("T377: decision_search lists without a query and filters by timeHorizon", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const search = tools.get("decision_search");
  await invoke(create, root, { decision: "long ruling" });
  await invoke(create, root, { decision: "temp ruling", timeHorizon: "temporary" });

  const list = await invoke(search, root, {});
  assert.equal(list.value.ok, true, JSON.stringify(list.value));
  assert.equal(list.value.data.decisions.length, 2);
  assert.ok(list.value.data.decisions.every((d) => d.timeHorizon === "long_term" || d.timeHorizon === "temporary"));

  const temporary = await invoke(search, root, { timeHorizon: "temporary" });
  assert.equal(temporary.value.ok, true, JSON.stringify(temporary.value));
  assert.equal(temporary.value.data.decisions.length, 1);
  assert.equal(temporary.value.data.decisions[0].timeHorizon, "temporary");

  // The frozen rejection of an empty query string survives at the tool face.
  const emptyQuery = await invoke(search, root, { query: "" });
  assert.equal(emptyQuery.value.ok, false);
  assert.equal(emptyQuery.value.error.code, "VALIDATION_FAILED");
  assert.equal(emptyQuery.value.error.field, "query");
});

test("T377: tool schemas expose the extension fields and keep bl out of the enum", () => {
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  const byName = new Map(createDecisionTools(deps).map((tool) => [tool.name, tool]));
  const createParams = byName.get("decision_create").parameters;
  for (const field of ["externalId", "refs", "replaces"]) {
    assert.ok(createParams[field] !== undefined, "create parameter " + field);
    assert.notEqual(createParams[field].required, true, field + " is optional");
  }
  const refType = createParams.refs.items.properties.type;
  assert.deepEqual(refType.enum, ["decision", "task", "plan", "commit"]);
  assert.ok(!refType.enum.includes("bl"), "the direction rule is visible in the schema");
  assert.equal(createParams.timeHorizon.description.includes("long_term"), true);

  const batchParams = byName.get("decision_create_batch").parameters;
  assert.ok(batchParams.decisions.items.properties.externalId !== undefined);
  const batchData = byName.get("decision_create_batch").output.schema.properties.data;
  assert.ok(batchData.properties.decisions.items.properties.existingProjectId !== undefined);

  const searchParams = byName.get("decision_search").parameters;
  assert.ok(searchParams.replacedDecisionId !== undefined, "task-615: reverse supersession parameter is declared");
  assert.notEqual(searchParams.replacedDecisionId.required, true, "replacedDecisionId is optional");
  assert.notEqual(searchParams.query.required, true, "query is optional: omission lists");
  assert.deepEqual(searchParams.timeHorizon.enum, ["long_term", "temporary"]);

  const createData = byName.get("decision_create").output.schema.properties.data;
  assert.ok(createData.properties.externalId !== undefined);
  assert.ok(createData.properties.alreadyExisted !== undefined);
  // task-600 ③: the ownership marker is declared, not only emitted.
  assert.ok(createData.properties.existingProjectId !== undefined);
  assert.equal(createData.properties.existingProjectId.description.includes("DIFFERENT project"), true);
  const getData = byName.get("decision_get").output.schema.properties.data;
  assert.ok(getData.properties.externalId !== undefined);
  assert.ok(getData.properties.replaces !== undefined);
  const searchData = byName.get("decision_search").output.schema.properties.data;
  assert.ok(searchData.properties.decisions.items.properties.timeHorizon !== undefined);
  assert.ok(searchData.properties.decisions.items.properties.replaces !== undefined, "task-615: list items declare replaces");
  assert.equal(searchData.properties.decisions.items.properties.replaces.required, true);
});

test("task-600: the tool face rejects a padded key and marks a key owned by another project", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const padded = await invoke(create, root, { decision: "padded", externalId: " D-1120" });
  assert.equal(padded.value.ok, false, JSON.stringify(padded.value));
  assert.equal(padded.value.error.code, "VALIDATION_FAILED");
  assert.equal(padded.value.error.field, "externalId");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);

  // A decision owned by another project: session-377 is bound to project 1.
  const other = store.createProject({ name: "Borealis", projectKey: "borealis" });
  assert.equal(other.ok, true, JSON.stringify(other));
  const theirs = store.createDecision(other.data.projectId, { decision: "owned elsewhere", externalId: "BL-584" });
  assert.equal(theirs.ok, true, JSON.stringify(theirs));
  const hit = await invoke(create, root, { decision: "mine", externalId: "BL-584" });
  assert.equal(hit.value.ok, true, JSON.stringify(hit.value));
  assert.equal(hit.value.data.alreadyExisted, true);
  assert.equal(hit.value.data.existingProjectId, other.data.projectId, "the tool face says whose key it is");
  assert.equal(hit.value.data.decisionId, theirs.data.decisionId);

  const mineAgain = await invoke(create, root, { decision: "mine", externalId: "DSD-1" });
  assert.equal(mineAgain.value.ok, true, JSON.stringify(mineAgain.value));
  assert.equal("existingProjectId" in mineAgain.value.data, false, "a same-project create carries no marker");
});

test("task-615: decision_search exposes the reverse supersession query through the tool face", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const search = tools.get("decision_search");
  const oldOne = await invoke(create, root, { decision: "old ruling" });
  const newer = await invoke(create, root, { decision: "newer ruling", replaces: [oldOne.value.data.decisionId] });
  assert.deepEqual(
    (await invoke(tools.get("decision_get"), root, { decisionId: newer.value.data.decisionId })).value.data.replaces,
    [oldOne.value.data.decisionId],
  );

  const reverse = await invoke(search, root, { replacedDecisionId: oldOne.value.data.decisionId });
  assert.equal(reverse.value.ok, true, JSON.stringify(reverse.value));
  assert.deepEqual(reverse.value.data.decisions.map((d) => d.decisionId), [newer.value.data.decisionId]);
  assert.deepEqual(reverse.value.data.decisions[0].replaces, [oldOne.value.data.decisionId], "list items carry the declaration");

  const miss = await invoke(search, root, { replacedDecisionId: 9999 });
  assert.equal(miss.value.ok, true, JSON.stringify(miss.value));
  assert.deepEqual(miss.value.data.decisions, [], "nothing replaced it: an empty page, not an error");

  const bad = await invoke(search, root, { replacedDecisionId: "1" });
  assert.equal(bad.value.ok, false, JSON.stringify(bad.value));
  assert.equal(bad.value.error.field, "replacedDecisionId");
});

// --------------------------------------------------- task-393 refs-of surface

test("T393: decision_get exposes refs and decision_search answers the reverse query", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const get = tools.get("decision_get");
  const search = tools.get("decision_search");

  const created = await invoke(create, root, { decision: "has downstream", refs: [{ type: "task", id: "T-194" }] });
  assert.equal(created.value.ok, true, JSON.stringify(created.value));
  const id = created.value.data.decisionId;

  const got = await invoke(get, root, { decisionId: id });
  assert.equal(got.value.ok, true, JSON.stringify(got.value));
  assert.deepEqual(got.value.data.refs, [{ type: "task", id: "T-194" }]);

  const bare = await invoke(create, root, { decision: "no downstream" });
  const bareGot = await invoke(get, root, { decisionId: bare.value.data.decisionId });
  assert.deepEqual(bareGot.value.data.refs, []);

  const reverse = await invoke(search, root, { refType: "task", refId: "T-194" });
  assert.equal(reverse.value.ok, true, JSON.stringify(reverse.value));
  assert.deepEqual(reverse.value.data.decisions.map((d) => d.decisionId), [id]);

  const empty = await invoke(search, root, { refType: "task", refId: "T-000" });
  assert.equal(empty.value.ok, true, JSON.stringify(empty.value));
  assert.deepEqual(empty.value.data.decisions, []);

  // Direction consistency at the tool face: bl is rejected as a filter type.
  const reversed = await invoke(search, root, { refType: "bl", refId: "BL-584" });
  assert.equal(reversed.value.ok, false);
  assert.equal(reversed.value.error.code, "VALIDATION_FAILED");
  assert.equal(reversed.value.error.field, "refType");
  const half = await invoke(search, root, { refType: "task" });
  assert.equal(half.value.ok, false);
  assert.equal(half.value.error.field, "refId");
});

test("T393: schemas expose refs on get and the reverse filter on search", () => {
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  const byName = new Map(createDecisionTools(deps).map((tool) => [tool.name, tool]));
  const getData = byName.get("decision_get").output.schema.properties.data;
  assert.ok(getData.properties.refs !== undefined, "get output declares refs");
  assert.deepEqual(getData.properties.refs.items.properties.type.enum, ["decision", "task", "plan", "commit"]);
  const searchParams = byName.get("decision_search").parameters;
  assert.notEqual(searchParams.refType.required, true, "refType is optional");
  assert.notEqual(searchParams.refId.required, true, "refId is optional");
  assert.deepEqual(searchParams.refType.enum, ["decision", "task", "plan", "commit"]);
  assert.ok(!searchParams.refType.enum.includes("bl"), "the direction rule is visible in the filter schema");
  assert.match(byName.get("decision_search").description, /refType and refId/i);
  assert.match(byName.get("decision_get").description, /refs/i);
});

// --------------------------------------------------- task-405 refs add-only append

test("T405: decision_update appends refs through the tool face and reports them", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const update = tools.get("decision_update");
  const get = tools.get("decision_get");
  const created = await invoke(create, root, { decision: "rule first", refs: [{ type: "decision", id: "D-1245" }] });
  assert.equal(created.value.ok, true, JSON.stringify(created.value));
  const id = created.value.data.decisionId;
  const appended = await invoke(update, root, { decisionId: id, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-405" }] } });
  assert.equal(appended.value.ok, true, JSON.stringify(appended.value));
  assert.deepEqual(appended.value.data.changedFields, ["refs"]);
  assert.equal(appended.value.data.revision, 2);
  const got = await invoke(get, root, { decisionId: id });
  assert.deepEqual(got.value.data.refs, [{ type: "decision", id: "D-1245" }, { type: "task", id: "T-405" }]);
  // The direction rule holds at the append face too.
  const reversed = await invoke(update, root, { decisionId: id, expectedRevision: 2, patch: { refs: [{ type: "bl", id: "BL-584" }] } });
  assert.equal(reversed.value.ok, false);
  assert.equal(reversed.value.error.code, "VALIDATION_FAILED");
  assert.equal(reversed.value.error.field, "refs");
});

test("T405: update schema declares add-only refs inside patch, content fields kept", () => {
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  const byName = new Map(createDecisionTools(deps).map((tool) => [tool.name, tool]));
  const update = byName.get("decision_update");
  const patch = update.parameters.patch;
  assert.ok(patch.properties.refs !== undefined, "patch declares refs");
  assert.notEqual(patch.properties.refs.required, true, "refs stays optional");
  assert.deepEqual(patch.properties.refs.items.properties.type.enum, ["decision", "task", "plan", "commit"]);
  assert.ok(!patch.properties.refs.items.properties.type.enum.includes("bl"), "direction rule visible in the append schema");
  assert.match(update.description, /add-only/i);
  for (const field of ["summary", "decision", "rationale", "timeHorizon", "decisionDate", "reviewDate", "sourceReference"]) {
    assert.ok(patch.properties[field] !== undefined, field + " kept");
  }
});

test("T424: search schema declares queryMode and keywords mode works end-to-end", async (t) => {
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  const byName = new Map(createDecisionTools(deps).map((tool) => [tool.name, tool]));
  const params = byName.get("decision_search").parameters;
  assert.ok(params.queryMode !== undefined, "queryMode declared");
  assert.notEqual(params.queryMode.required, true, "queryMode optional (default literal)");
  assert.deepEqual(params.queryMode.enum, ["literal", "keywords"]);
  assert.match(byName.get("decision_search").description, /keywords/i);

  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const search = tools.get("decision_search");
  await invoke(create, root, { decision: "DSD 注册修法 defineTool 包装", externalId: "D-1238" });
  const literal = await invoke(search, root, { query: "注册修法 defineTool" });
  assert.equal(literal.value.ok, true);
  assert.equal(literal.value.data.decisions.length, 1, "the exact phrase happens to be a substring here");
  const gap = await invoke(search, root, { query: "DSD defineTool" });
  assert.equal(gap.value.data.decisions.length, 0, "multi-word gap: literal default unchanged");
  const keywords = await invoke(search, root, { query: "DSD defineTool", queryMode: "keywords" });
  assert.equal(keywords.value.ok, true, JSON.stringify(keywords.value));
  assert.equal(keywords.value.data.decisions.length, 1, "keywords mode closes the multi-word gap");
  assert.equal(keywords.value.data.decisions[0].externalId, "D-1238", "hit identified by ledger D number");
  const refused = await invoke(search, root, { queryMode: "keywords" });
  assert.equal(refused.value.ok, false);
  assert.equal(refused.value.error.field, "queryMode", "fail-closed at the tool face too");
});

// ------------------------------------------------- task-1 dispatch-gap surface
// Requirements §3 P0 through the model-facing face. The fixtures are the real
// accident shapes: D-896 (effective, no task edge, alarm should fire), D-899
// (registers a BL item and DID get a card), D-1277 (no references at all).

test("task-1: decision_search answers the no-downstream-task question in one call, and the edge-kind summary stays opt-in", async (t) => {
  const store = storeFor(t);
  const { root, tools } = boundTools(t, store);
  const create = tools.get("decision_create");
  const search = tools.get("decision_search");
  const gapShape = await invoke(create, root, { decision: "D-896 shape", externalId: "D-896", refs: [{ type: "plan", id: "PLAN-0762" }] });
  const carded = await invoke(create, root, { decision: "D-899 shape", externalId: "D-899", refs: [{ type: "task", id: "task-124" }] });
  const bare = await invoke(create, root, { decision: "nothing referenced", externalId: "D-1277" });

  // Default list unchanged: same three hits, same order, and no new keys.
  const plain = await invoke(search, root, {});
  assert.equal(plain.value.ok, true, JSON.stringify(plain.value));
  assert.deepEqual(plain.value.data.decisions.map((d) => d.externalId), ["D-1277", "D-899", "D-896"]);
  for (const item of plain.value.data.decisions) {
    assert.equal("refs" in item, false, "list items never carry reference ids");
    assert.equal("refTypes" in item, false, "the edge-kind summary is opt-in");
  }

  // The gap: D-896 and the bare record; D-899 is excluded because it HAS a task edge.
  const gap = await invoke(search, root, { withoutRefType: "task" });
  assert.equal(gap.value.ok, true, JSON.stringify(gap.value));
  assert.deepEqual(gap.value.data.decisions.map((d) => d.externalId), ["D-1277", "D-896"]);
  assert.equal(gap.value.data.decisions.some((d) => d.decisionId === carded.value.data.decisionId), false,
    "a decision with a downstream task is not in the gap");

  // One page answers both questions when the edge-kind summary is requested.
  const listed = await invoke(search, root, { withoutRefType: "task", withRefTypes: true });
  assert.equal(listed.value.ok, true, JSON.stringify(listed.value));
  const byExt = new Map(listed.value.data.decisions.map((d) => [d.externalId, d]));
  assert.deepEqual(byExt.get("D-896").refTypes, ["plan"], "kinds, not ids");
  assert.deepEqual(byExt.get("D-1277").refTypes, []);
  assert.equal(listed.value.data.hasMore, false);
  assert.deepEqual(listed.value.data.decisions.map((d) => d.decisionId),
    [bare.value.data.decisionId, gapShape.value.data.decisionId], "the flag does not reorder the page");

  // Fail-closed at the tool face, as a domain envelope rather than a throw.
  const badType = await invoke(search, root, { withoutRefType: "bl" });
  assert.equal(badType.value.ok, false);
  assert.equal(badType.value.error.code, "VALIDATION_FAILED");
  assert.equal(badType.value.error.field, "withoutRefType");
  const contradictory = await invoke(search, root, { refType: "task", refId: "task-124", withoutRefType: "task" });
  assert.equal(contradictory.value.ok, false);
  assert.equal(contradictory.value.error.field, "withoutRefType");
});

test("task-1: search schema declares the new inputs, the shared ref-type enum, and the refs summary", () => {
  const deps = { agents: registryOf([liveAgent("s")]), openStore: () => ({}), asker: refusingAsker() };
  const search = createDecisionTools(deps).find((tool) => tool.name === "decision_search");
  const params = search.parameters;
  assert.ok(params.withoutRefType !== undefined, "withoutRefType declared");
  assert.notEqual(params.withoutRefType.required, true, "optional: omitting it adds no filter");
  // One shared constant: the complement filter cannot drift from refType.
  assert.deepEqual(params.withoutRefType.enum, params.refType.enum);
  assert.deepEqual(params.withoutRefType.enum, ["decision", "task", "plan", "commit"]);
  assert.equal(params.withoutRefType.enum.includes("bl"), false, "bl is not an edge kind, so not a filter value");
  assert.ok(params.withRefTypes !== undefined, "withRefTypes declared");
  assert.notEqual(params.withRefTypes.required, true, "off by default");
  assert.equal(params.withRefTypes.type, "boolean");

  const item = search.output.schema.properties.data.properties.decisions.items;
  assert.ok(item.properties.refTypes !== undefined, "hits may carry the edge-kind summary");
  assert.notEqual(item.properties.refTypes.required, true, "present only when asked for");
  // One shared type domain, and the schema says "kinds only": array of enum
  // strings, with no id property anywhere in the item shape.
  assert.deepEqual(item.properties.refTypes.items.enum, params.refType.enum);
  assert.equal(item.properties.refTypes.items.properties, undefined, "refTypes is a list of kinds, not objects");
  assert.equal("refs" in item.properties, false, "the summary never carries ids");
  assert.equal("refsTruncated" in item.properties, false, "no truncation flag: kinds cannot overflow");

  // Wording contract (Lead ruling): describe the query, never claim the whole
  // alarm — a BL item is not an edge, so "no task edge" cannot cover it.
  assert.match(search.description, /withoutRefType/);
  assert.match(search.description, /no downstream task/i);
  assert.match(params.withoutRefType.description, /NO reference edge/);
  assert.match(params.withoutRefType.description, /BL-/);
  assert.equal(/落空决策/.test(search.description + params.withoutRefType.description), false,
    "the label must not swallow the BL item classes");

  // The list summary explains what it does NOT say (ids) and why it is not a
  // seventh tool: the frozen model face is exactly the six names below.
  assert.match(params.withRefTypes.description, /decision_get for the ids/i);
  assert.match(params.withRefTypes.description, /six tools/i);
  assert.match(params.withRefTypes.description, /decision-contract\.md §3/);
  for (const name of DECISION_TOOL_NAMES) {
    assert.ok(params.withRefTypes.description.includes(name), "frozen tool name listed: " + name);
  }
  assert.equal(DECISION_TOOL_NAMES.length, 6, "the frozen surface stays six tools");
});


// ------------------------------------------------ task-14 (A2): first-question window

test("task-14: the configured first-question window reaches the Host askTimed call and a timeout writes nothing", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  const timed = [];
  const asker = {
    async ask() { throw new Error("the blocking ask() must not be used when a window is configured"); },
    async askTimed(_agent, prompt, callId, timeoutMs) {
      timed.push({ promptId: prompt.id, callId, timeoutMs });
      return { kind: "pending", callId: String(callId) };
    },
  };
  const deps = { agents: registryOf([root]), openStore: () => store, asker, projectTimeoutMs: 45_000 };
  const search = createDecisionTools(deps).find((entry) => entry.name === "decision_search");
  const outcome = await invoke(search, root, { limit: 1 });

  assert.equal(outcome.threw, false, JSON.stringify(outcome));
  assert.equal(outcome.value.ok, false);
  assert.equal(outcome.value.error.code, "PROJECT_REQUIRED");
  assert.match(outcome.value.error.message, /did not answer in time/u);
  assert.equal(timed.length, 1, "只问一次");
  assert.equal(timed[0].timeoutMs, 45_000, "配置值原样交给宿主计时器");
  assert.equal(timed[0].callId, "dsd-project-choice", "前台等待按稳定 callId 记账");
  assert.equal(store.getBoundProject("session-root").data, null, "超时零写入");
  assert.equal(store.listProjects().data.length, 1, "超时不建项目");
});

test("task-46: 省略 timeHorizon 在工具面落 long_term（单条与批量），显式值仍然胜出", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const deps = { agents: registryOf([root]), openStore: () => store, asker: chooserFor("Atlas · atlas") };
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  const tools = createDecisionTools(deps);
  const create = tools.find((tool) => tool.name === "decision_create");
  const batch = tools.find((tool) => tool.name === "decision_create_batch");

  // 描述写 long_term、解析器曾默认 temporary、store 另有一套缺省 —— 三处只有一处能是真相。
  // 这里钉住调用方看得见的那一层：工具面省略该字段后，库里必须是 long_term。
  const single = await invoke(create, root, { decision: "省略 horizon（单条）" });
  assert.equal(single.value.ok, true, JSON.stringify(single.value));
  const singleRow = store.getDecision(1, { decisionId: single.value.data.decisionId });
  assert.equal(singleRow.data.timeHorizon, "long_term", "单条省略必须落 long_term，不得落 temporary");
  assert.deepEqual(single.value.data, {
    decisionId: single.value.data.decisionId,
    revision: 1,
    summary: null,
    status: "effective",
    createdAt: single.value.data.createdAt,
  }, "回执不暴露 timeHorizon，判据只能看库");

  const many = await invoke(batch, root, {
    decisions: [{ decision: "省略 horizon（批量）" }, { decision: "显式 temporary", timeHorizon: "temporary" }],
  });
  assert.equal(many.value.ok, true, JSON.stringify(many.value));
  const horizons = many.value.data.decisions.map(
    (decision) => store.getDecision(1, { decisionId: decision.decisionId }).data.timeHorizon,
  );
  assert.deepEqual(horizons, ["long_term", "temporary"], "批内逐条独立缺省，显式值不被覆盖");

  const explicit = await invoke(create, root, { decision: "显式 temporary（单条）", timeHorizon: "temporary" });
  assert.equal(store.getDecision(1, { decisionId: explicit.value.data.decisionId }).data.timeHorizon, "temporary");
});

