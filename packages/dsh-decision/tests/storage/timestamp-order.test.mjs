import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";

const dataOf = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.data; };

// Windows holds the sqlite file briefly after close; retry instead of leaking temp dirs.
const cleanup = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

function storeFor(t) {
  const root = mkdtempSync(join(tmpdir(), "ts-order-"));
  const store = SQLiteDecisionStore.open({ databasePath: join(root, "d.sqlite") });
  t.after(() => { store.close(); cleanup(root); });
  return { store, root };
}

// Pressure test: the exact failure scenario from task-281, 300 rounds.
// Reproduces dsd-1's probe: three inserts inside one millisecond, then one update,
// then the contract's updatedAt DESC / id DESC ordering assertion (line 114).
test("300-round pressure: no timestamp collisions and no wrong order", (_t) => {
  const runs = 300;
  let collisions = 0;
  let wrongOrder = 0;
  const failures = [];
  for (let run = 0; run < runs; run += 1) {
    const root = mkdtempSync(join(tmpdir(), "pressure-"));
    const store = SQLiteDecisionStore.open({ databasePath: join(root, "d.sqlite") });
    try {
      const p = dataOf(store.createProject({ name: "P", projectKey: "p" }));
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push(dataOf(store.createDecision(p.projectId, { decision: "ordered " + i })).decisionId);
      dataOf(store.updateDecision(p.projectId, { decisionId: ids[0], expectedRevision: 1, patch: { decision: "ordered 0 revised" } }));
      const stamps = ids.map((id) => dataOf(store.getDecision(p.projectId, { decisionId: id })).updatedAt);
      if (new Set(stamps).size < 3) collisions += 1;
      const order = dataOf(store.searchDecisions(p.projectId, { query: "ordered" })).decisions.map((d) => d.decisionId);
      const expected = [ids[0], ids[2], ids[1]];
      if (JSON.stringify(order) !== JSON.stringify(expected)) {
        wrongOrder += 1;
        if (failures.length < 3) failures.push({ run, order, expected, stamps });
      }
    } finally { store.close(); cleanup(root); }
  }
  console.log("runs=" + runs + " timestamp-collisions=" + collisions + " wrong-order=" + wrongOrder);
  if (failures.length > 0) console.log("first failures: " + JSON.stringify(failures));
  assert.equal(collisions, 0, "updated_at must be unique inside one project");
  assert.equal(wrongOrder, 0, "search must order by update recency");
});

// Criterion 3: reopening a current-version database performs no migration.
// Ticks are allocated at write time, so every already-stored row keeps its exact
// updatedAt value. (The task-377 v1->v2 migration is covered separately in
// sqlite-store.test.mjs; it also preserves stored rows.)
test("existing rows keep their stored updatedAt across reopen (no re-migration)", (_t) => {
  const root = mkdtempSync(join(tmpdir(), "reopen-"));
  const databasePath = join(root, "d.sqlite");
  const store = SQLiteDecisionStore.open({ databasePath });
  const p = dataOf(store.createProject({ name: "P", projectKey: "p" }));
  const ids = [1, 2].map(() => dataOf(store.createDecision(p.projectId, { decision: "kept" })).decisionId);
  const before = ids.map((id) => dataOf(store.getDecision(p.projectId, { decisionId: id })).updatedAt);
  store.close();

  const reopened = SQLiteDecisionStore.open({ databasePath });
  try {
    const after = ids.map((id) => dataOf(reopened.getDecision(p.projectId, { decisionId: id })).updatedAt);
    assert.deepEqual(after, before, "updatedAt must not be rewritten on reopen");
    assert.equal(reopened.database.prepare("PRAGMA user_version").get().user_version, 3, "schema version unchanged");
    const columns = reopened.database.prepare("SELECT name FROM pragma_table_info('decisions') ORDER BY cid").all().map((row) => row.name);
    assert.deepEqual(columns, ["id", "revision", "project_id", "decision_text", "summary", "rationale",
      "time_horizon", "decision_date", "review_date", "status", "void_reason", "voided_at",
      "source_reference", "created_at", "updated_at", "external_id", "replaces_json"],
    "task-377 appended exactly two columns and task-615 added none (v3 adds a table, not a decisions column); none was renamed");
  } finally { reopened.close(); cleanup(root); }
});

// Boundary: ordering is per project, because search never spans projects (line 114).
test("ordering is per project and does not force cross-project monotonicity", (t) => {
  const { store } = storeFor(t);
  const a = dataOf(store.createProject({ name: "Alpha", projectKey: "alpha" }));
  const b = dataOf(store.createProject({ name: "Beta", projectKey: "beta" }));
  const a1 = dataOf(store.createDecision(a.projectId, { decision: "alpha one" })).decisionId;
  const b1 = dataOf(store.createDecision(b.projectId, { decision: "beta one" })).decisionId;
  const a2 = dataOf(store.createDecision(a.projectId, { decision: "alpha two" })).decisionId;
  const stamps = [a1, a2].map((id) => dataOf(store.getDecision(a.projectId, { decisionId: id })).updatedAt);
  assert.equal(new Set(stamps).size, 2, "a single project stays strictly ordered");
  const hitsA = dataOf(store.searchDecisions(a.projectId, { query: "alpha" })).decisions.map((d) => d.decisionId);
  assert.deepEqual(hitsA, [a2, a1], "inside a project the later write sorts first");
  const hitsB = dataOf(store.searchDecisions(b.projectId, { query: "beta" })).decisions.map((d) => d.decisionId);
  assert.deepEqual(hitsB, [b1]);
});

// Boundary: void allocates its own tick, so a voided row sorts as the newest write.
test("void allocates its own ordering tick", (t) => {
  const { store } = storeFor(t);
  const p = dataOf(store.createProject({ name: "P", projectKey: "p" }));
  const ids = [0, 1, 2].map((i) => dataOf(store.createDecision(p.projectId, { decision: "v " + i })).decisionId);
  dataOf(store.voidDecision(p.projectId, { decisionId: ids[1], expectedRevision: 1, reason: "superseded" }));
  const effective = dataOf(store.searchDecisions(p.projectId, { query: "v" })).decisions.map((d) => d.decisionId);
  assert.deepEqual(effective, [ids[2], ids[0]], "voided row is hidden by default and order is recency");
  const all = dataOf(store.searchDecisions(p.projectId, { query: "v", includeVoided: true })).decisions.map((d) => d.decisionId);
  assert.deepEqual(all, [ids[1], ids[2], ids[0]], "the voided row moved to the top of the recency order");
});
