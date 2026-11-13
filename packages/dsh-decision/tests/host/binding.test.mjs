import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";
import {
  bindExistingProject,
  createAndBindNewProject,
  getCurrentBinding,
  listSelectableProjects,
} from "../../src/host/binding.ts";

/**
 * Binding service L0 (PLAN-0778 B, contract §2 lines 78/82/84).
 *
 * The service must not reimplement storage: it calls the PLAN-0777 store
 * methods and returns the PLAN-0777 `SessionBindingRecord` shape (ruling D4).
 * These tests pin that by asserting the exact field set, and by proving the
 * store-level atomicity/rollback/idempotency the service inherits.
 */

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function storeFor(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-binding-"));
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

/** The PLAN-0777 receipt field set (sqlite-store.ts:42-44 + :34-40). Ruling D4. */
const SESSION_BINDING_FIELDS = ["projectId", "name", "projectKey", "createdAt", "updatedAt", "sessionId"];

function assertBindingShape(record) {
  assert.deepEqual(Object.keys(record).sort(), [...SESSION_BINDING_FIELDS].sort());
  assert.equal(typeof record.projectId, "number");
  assert.equal(typeof record.name, "string");
  assert.equal(typeof record.projectKey, "string");
  assert.equal(typeof record.createdAt, "string");
  assert.equal(typeof record.updatedAt, "string");
  assert.equal(typeof record.sessionId, "string");
}

/** A counting store wrapper proves whether the service touched storage at all. */
function countingStore(store) {
  const calls = [];
  return {
    calls,
    inner: store,
    listProjects() { calls.push("listProjects"); return store.listProjects(); },
    getBoundProject(sessionId) { calls.push("getBoundProject"); return store.getBoundProject(sessionId); },
    bindSession(sessionId, projectId) { calls.push("bindSession"); return store.bindSession(sessionId, projectId); },
    createAndBindProject(sessionId, input) { calls.push("createAndBindProject"); return store.createAndBindProject(sessionId, input); },
  };
}

test("create-and-bind commits project and binding together and returns the PLAN-0777 receipt shape", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const result = createAndBindNewProject(root, registryOf([root]), () => store, { name: "Atlas", projectKey: "atlas" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assertBindingShape(result.data);

  // Both facts are true in the database, under the caller's own session id.
  const bound = store.getBoundProject("session-root");
  assert.equal(bound.ok, true);
  assert.equal(bound.data.projectId, result.data.projectId);
  assert.equal(bound.data.projectKey, "atlas");
  const projects = store.listProjects();
  assert.equal(projects.ok, true);
  assert.equal(projects.data.length, 1);
});

test("a rejected caller never opens the store (fail closed before data access)", (t) => {
  const store = countingStore(storeFor(t));
  const root = liveAgent("session-root");
  const child = liveAgent("session-child");
  const opened = [];
  const openStore = () => { opened.push("opened"); return store; };

  // missing caller
  const missing = createAndBindNewProject(undefined, registryOf([root]), openStore, { name: "Atlas", projectKey: "atlas" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "CALLER_REQUIRED");

  // non-live caller
  const impostor = liveAgent("session-root");
  const notLive = listSelectableProjects(impostor, registryOf([root]), openStore);
  assert.equal(notLive.ok, false);
  assert.equal(notLive.reason, "CALLER_NOT_LIVE");

  // delegated (live child)
  const delegated = bindExistingProject(child, registryOf([root], [child]), openStore, 1);
  assert.equal(delegated.ok, false);
  assert.equal(delegated.reason, "DELEGATED_CALLER");

  // The point of the test: no store call of any kind happened.
  assert.deepEqual(opened, []);
  assert.deepEqual(store.calls, []);
});

test("binding uses the verified caller session id, not any client-supplied id", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const other = liveAgent("session-other");
  const registry = registryOf([root, other]);

  // Bind through the root. There is no sessionId parameter to pass.
  const created = createAndBindNewProject(root, registry, () => store, { name: "Atlas", projectKey: "atlas" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.sessionId, "session-root");

  // The other live root sees no binding of its own, and cannot inherit it.
  const otherBinding = getCurrentBinding(other, registry, () => store);
  assert.equal(otherBinding.ok, true);
  assert.equal(otherBinding.data, null);
});

test("repeated identical binding is idempotent and a different project is refused", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  const first = createAndBindNewProject(root, registry, () => store, { name: "Atlas", projectKey: "atlas" });
  assert.equal(first.ok, true);
  const projectId = first.data.projectId;

  // A second session binds the same project (contract §2 line 82: shared projects).
  const second = liveAgent("session-second");
  const shared = bindExistingProject(second, registryOf([root, second]), () => store, projectId);
  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.equal(shared.data.projectId, projectId);
  assert.equal(shared.data.sessionId, "session-second");

  // The same session re-binding the same project is idempotent, no new row.
  const again = bindExistingProject(root, registry, () => store, projectId);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.data.sessionId, "session-root");
  const bound = store.getBoundProject("session-root");
  assert.equal(bound.data.projectId, projectId);

  // A session already bound cannot be moved to another project silently.
  const otherProject = createAndBindNewProject(second, registryOf([root, second]), () => store, { name: "Borealis", projectKey: "borealis" });
  assert.equal(otherProject.ok, false);
  assert.equal(otherProject.error.code, "VALIDATION_FAILED");
  assert.equal(otherProject.error.field, "sessionId");
});

test("a failed create-and-bind leaves neither the project nor the binding behind", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);

  // Duplicate project_key makes the INSERT fail inside the transaction.
  const first = createAndBindNewProject(root, registry, () => store, { name: "Atlas", projectKey: "atlas" });
  assert.equal(first.ok, true);
  const secondSession = liveAgent("session-second");
  const conflict = createAndBindNewProject(secondSession, registryOf([root, secondSession]), () => store, { name: "Atlas two", projectKey: "atlas" });
  assert.equal(conflict.ok, false, JSON.stringify(conflict));
  assert.equal(conflict.error.code, "VALIDATION_FAILED");

  // Contract §2 line 82: the failure persists neither row.
  const projects = store.listProjects();
  assert.equal(projects.data.length, 1);
  assert.equal(store.getBoundProject("session-second").data, null);
});

test("project input validation is the domain layer's, not re-implemented here", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  for (const bad of [
    { name: "Atlas" },
    { projectKey: "atlas" },
    { name: "", projectKey: "atlas" },
    { name: "Atlas", projectKey: "Atlas" },
    { name: "Atlas", projectKey: "atlas_core" },   // underscore is outside the kebab alphabet
    { name: "Atlas", projectKey: "atlas", extra: true },
    null,
  ]) {
    const result = createAndBindNewProject(root, registry, () => store, bad);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, "VALIDATION_FAILED");
    assert.equal(store.listProjects().data.length, 0);
  }
});

test("selectable projects expose the name and key the question card needs", (t) => {
  const store = storeFor(t);
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  createAndBindNewProject(root, registry, () => store, { name: "Atlas", projectKey: "atlas" });
  const survey = liveAgent("session-survey");
  const result = listSelectableProjects(survey, registryOf([root, survey]), () => store);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.length, 1);
  for (const project of result.data) {
    assert.deepEqual(Object.keys(project).sort(), ["createdAt", "name", "projectId", "projectKey", "updatedAt"]);
  }
});
