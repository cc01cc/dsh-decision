import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";
import {
  NEW_PROJECT_LABEL,
  buildKeySuggestion,
  buildProjectChoicePrompt,
  projectOptionLabel,
  readProjectKey,
  readProjectName,
  resolveProjectChoice,
  resolveSessionProject,
} from "../../src/host/first-binding.ts";

/**
 * First-binding provider L0 (PLAN-0778 T2.2, contract lines 79/80/82).
 *
 * Each test names the contract line it pins. The timeout tests exercise the
 * askTimed PENDING branch (the built-in resolves with {pending:true,callId}
 * instead of throwing), and assert ZERO writes — contract line 80.
 */

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function storeFor(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-first-binding-"));
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

/** Scripted asker: each reply is consumed in order, and every call is recorded. */
function scriptedAsker(replies) {
  const calls = [];
  let index = 0;
  const next = (agent, prompt) => {
    calls.push({ agent, prompt });
    const reply = replies[index];
    index += 1;
    return reply;
  };
  return {
    calls,
    async ask(agent, prompt) { return next(agent, prompt); },
    async askTimed(agent, prompt, callId, _timeoutMs) { return next(agent, prompt); },
  };
}

/** A store wrapper that records every write attempt, so "nothing written" is provable. */
function watchedStore(store) {
  const writes = [];
  return {
    writes,
    inner: store,
    listProjects() { return store.listProjects(); },
    getProjectByKey(key) { return store.getProjectByKey(key); },
    getBoundProject(sessionId) { return store.getBoundProject(sessionId); },
    bindSession(sessionId, projectId) { writes.push(["bindSession", sessionId, projectId]); return store.bindSession(sessionId, projectId); },
    createAndBindProject(sessionId, input) { writes.push(["createAndBindProject", sessionId, input]); return store.createAndBindProject(sessionId, input); },
  };
}

const ANSWERED = (label) => ({ kind: "answered", reply: { selected: [label] } });
const ANSWERED_CUSTOM = (text) => ({ kind: "answered", reply: { selected: [], custom: text } });
const CANCELLED = { kind: "cancelled", reason: "The user cancelled the question." };
const PENDING = { kind: "pending", callId: "call-1" };

// ---------------------------------------------------------------- contract line 79

test("line 79: the choice prompt lists every project as 名称 · key plus a create-new option", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  // Two projects with DIFFERENT names, and two that share a name but not a key.
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  store.createProject({ name: "Atlas", projectKey: "atlas-two" });
  store.createProject({ name: "Borealis", projectKey: "borealis" });

  const prompt = buildProjectChoicePrompt(store.listProjects().data);
  assert.equal(prompt.options.length, 4); // three projects + create-new
  assert.equal(prompt.multiSelect, false);
  const labels = prompt.options.map((option) => option.label);
  assert.deepEqual(labels.slice(-1), [NEW_PROJECT_LABEL]);
  for (const project of store.listProjects().data) {
    assert.ok(labels.includes(projectOptionLabel(project)), JSON.stringify(project));
  }
  // Same name, two keys: the labels stay distinguishable.
  assert.ok(labels.includes("Atlas · atlas"));
  assert.ok(labels.includes("Atlas · atlas-two"));
});

test("line 79: a selection is resolved by the 名称 · key label, never by bare name", () => {
  const projects = [
    { projectId: 1, name: "Atlas", projectKey: "atlas", createdAt: "x", updatedAt: "x" },
    { projectId: 2, name: "Atlas", projectKey: "atlas-two", createdAt: "x", updatedAt: "x" },
  ];

  // Exact label with key resolves to exactly one project.
  assert.equal(resolveProjectChoice({ selected: ["Atlas · atlas-two"] }, projects).kind, "existing");
  assert.equal(resolveProjectChoice({ selected: ["Atlas · atlas-two"] }, projects).project.projectId, 2);

  // A bare name is REFUSED: matching by name would silently pick one of two projects.
  const bare = resolveProjectChoice({ selected: ["Atlas"] }, projects);
  assert.equal(bare.kind, "refused");

  // A name prefix is refused too ("prefix guessing" is the failure mode).
  const prefix = resolveProjectChoice({ selected: ["Atl"] }, projects);
  assert.equal(prefix.kind, "refused");

  // Zero or two selections are refused.
  assert.equal(resolveProjectChoice({ selected: [] }, projects).kind, "refused");
  assert.equal(resolveProjectChoice({ selected: ["Atlas · atlas", "Atlas · atlas-two"] }, projects).kind, "refused");

  // The create-new option is recognised.
  assert.equal(resolveProjectChoice({ selected: [NEW_PROJECT_LABEL] }, projects).kind, "new");
});

test("line 79: an already bound session never sees a question", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  const asker = scriptedAsker([]);
  store.createAndBindProject("session-root", { name: "Atlas", projectKey: "atlas" });

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => store, asker });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.project.projectKey, "atlas");
  assert.deepEqual(asker.calls, []); // no question on a later call
});

// ---------------------------------------------------------------- contract line 80

test("line 80 step 2: the key suggestion uses ASCII runs only and never transliterates", () => {
  assert.deepEqual(buildKeySuggestion("Atlas Core", []), { suggestion: "atlas-core", conflicts: [] });
  assert.deepEqual(buildKeySuggestion("Atlas 核心", []), { suggestion: "atlas", conflicts: [] });
  // Pure Chinese yields no suggestion: step 4 must then require a typed key.
  assert.deepEqual(buildKeySuggestion("纯中文项目", []), { suggestion: null, conflicts: [] });
});

test("line 80 step 3: a colliding base key offers -2/-3 alternates and skips taken ones", () => {
  assert.deepEqual(buildKeySuggestion("Atlas", ["atlas"]), { suggestion: "atlas", conflicts: ["atlas-2", "atlas-3", "atlas-4"] });
  assert.deepEqual(buildKeySuggestion("Atlas", ["atlas", "atlas-2"]), { suggestion: "atlas", conflicts: ["atlas-3", "atlas-4", "atlas-5"] });
  // A free base key needs no alternates.
  assert.deepEqual(buildKeySuggestion("Atlas", ["borealis"]), { suggestion: "atlas", conflicts: [] });
});

test("line 80 step 4: a hand-typed key must satisfy the Q1 key format", () => {
  assert.equal(readProjectKey("atlas-core").ok, true);
  for (const bad of ["Atlas", "atlas_core", "atlas core", "-atlas", "atlas-", "", "a".repeat(49)]) {
    assert.equal(readProjectKey(bad).ok, false, bad);
  }
  assert.equal(readProjectName("  Atlas  ").data, "Atlas");
});

test("line 80: the full four-step dialog creates and binds in one transaction", async (t) => {
  const store = storeFor(t);
  const watched = watchedStore(store);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  // Answer 1: choose create-new. Answer 2: type the name. Answer 3: accept the key.
  const asker = scriptedAsker([ANSWERED(NEW_PROJECT_LABEL), ANSWERED_CUSTOM("Atlas"), ANSWERED("atlas")]);

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => watched, asker });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.project, { projectId: 1, name: "Atlas", projectKey: "atlas" });
  // Three prompts, in order: name then key; the choice prompt is first.
  assert.equal(asker.calls.length, 3);
  assert.equal(asker.calls[0].prompt.id, "dsd-project-choice");
  assert.equal(asker.calls[1].prompt.id, "dsd-project-name");
  assert.equal(asker.calls[2].prompt.id, "dsd-project-key");
  // Exactly one write, and it is the atomic create-and-bind.
  assert.deepEqual(watched.writes, [["createAndBindProject", "session-root", { name: "Atlas", projectKey: "atlas" }]]);
  assert.equal(store.getBoundProject("session-root").data.projectKey, "atlas");
});

test("line 80: choosing an existing project binds without creating anything", async (t) => {
  const store = storeFor(t);
  const watched = watchedStore(store);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  const seeded = store.createProject({ name: "Atlas", projectKey: "atlas" });
  const asker = scriptedAsker([ANSWERED("Atlas · atlas")]);

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => watched, asker });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.project, { projectId: seeded.data.projectId, name: "Atlas", projectKey: "atlas" });
  assert.deepEqual(watched.writes, [["bindSession", "session-root", seeded.data.projectId]]);
  assert.equal(asker.calls.length, 1);
});

// ------------------------------------------------- timeout / cancel write nothing

test("line 80: the askTimed PENDING branch writes nothing (timeout is not an error path)", async (t) => {
  const store = storeFor(t);
  const watched = watchedStore(store);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  const asker = scriptedAsker([PENDING]);

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => watched, asker, timeoutMs: 1000 });
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.reason, "PROJECT_REQUIRED");
  assert.deepEqual(watched.writes, []); // zero writes on timeout
  assert.equal(store.getBoundProject("session-root").data, null);
  // The pending branch is distinguishable from the answered path by the asker call.
  assert.equal(asker.calls.length, 1);
});

test("line 80: a timeout during the create dialog also writes nothing", async (t) => {
  const store = storeFor(t);
  const watched = watchedStore(store);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  // Choose create-new, then time out while typing the name.
  const asker = scriptedAsker([ANSWERED(NEW_PROJECT_LABEL), CANCELLED]);

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => watched, asker, timeoutMs: 1000 });
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.deepEqual(watched.writes, []);
  assert.equal(store.listProjects().data.length, 0);
});

test("line 80: cancelling the choice prompt writes nothing", async (t) => {
  const store = storeFor(t);
  const watched = watchedStore(store);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  const asker = scriptedAsker([CANCELLED]);

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => watched, asker });
  assert.equal(outcome.ok, false);
  assert.deepEqual(watched.writes, []);
  assert.equal(store.getBoundProject("session-root").data, null);
});

test("a caller problem is refused before any store or question access", async (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const child = liveAgent("session-child");
  const impostor = liveAgent("session-root");
  let opened = 0;
  const asker = scriptedAsker([ANSWERED(NEW_PROJECT_LABEL)]);

  for (const [agent, registry, reason] of [
    [undefined, registryOf([root]), "CALLER_REQUIRED"],
    [impostor, registryOf([root]), "CALLER_NOT_LIVE"],
    [child, registryOf([root], [child]), "DELEGATED_CALLER"],
  ]) {
    const outcome = await resolveSessionProject(agent, { agents: registry, openStore: () => { opened += 1; return store; }, asker });
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.reason, reason);
  }
  assert.equal(opened, 0); // fail closed before data access
  assert.deepEqual(asker.calls, []); // and before any question
});

test("a key that collides in this Profile DB is refused after the dialog, with no write", async (t) => {
  const store = storeFor(t);
  const watched = watchedStore(store);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  store.createProject({ name: "Atlas", projectKey: "atlas" });
  // The user types a key that already exists instead of taking the offered alternate.
  const asker = scriptedAsker([ANSWERED(NEW_PROJECT_LABEL), ANSWERED_CUSTOM("Atlas two"), ANSWERED_CUSTOM("atlas")]);

  const outcome = await resolveSessionProject(root, { agents: registry, openStore: () => watched, asker });
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.error.code, "VALIDATION_FAILED");
  assert.equal(outcome.error.field, "projectKey");
  assert.deepEqual(watched.writes, []);
  assert.equal(store.listProjects().data.length, 1);
});