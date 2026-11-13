import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function tempPath() {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-store-"));
  tempRoots.add(root);
  return { root, databasePath: join(root, "decisions.sqlite") };
}

function storeFor(t) {
  const paths = tempPath();
  const store = SQLiteDecisionStore.open({ databasePath: paths.databasePath });
  t.after(() => store.close());
  return { ...paths, store };
}

function dataOf(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function errorOf(result, code, field) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  if (field !== undefined) assert.equal(result.error.field, field);
  return result.error;
}

function withStatement(database, sql, callback) {
  const statement = database.prepare(sql);
  return callback(statement);
}

function pragma(database, name) {
  return withStatement(database, `PRAGMA ${name}`, (statement) => Object.values(statement.get())[0]);
}

function countRows(database, table, where = "") {
  return withStatement(database, `SELECT count(*) AS count FROM ${table} ${where}`, (statement) => statement.get().count);
}

function createProject(store, name = "Atlas", projectKey = "atlas") {
  return dataOf(store.createProject({ name, projectKey }));
}

function createDecision(store, projectId, decision = "Use SQLite.", extra = {}) {
  return dataOf(store.createDecision(projectId, { decision, ...extra }));
}

function insertRawProject(database, projectKey, name = "Atlas") {
  return withStatement(database,
    "INSERT INTO projects (project_key, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    (statement) => statement.run(projectKey, name, "2026-11-12T00:00:00.000Z", "2026-11-12T00:00:00.000Z"),
  );
}

function insertRawDecision(database, projectId, fields = {}) {
  const values = {
    decision: "Raw decision",
    summary: null,
    rationale: null,
    timeHorizon: "temporary",
    decisionDate: null,
    reviewDate: null,
    sourceReference: null,
    ...fields,
  };
  return withStatement(database,
    `INSERT INTO decisions (
      project_id, decision_text, summary, rationale, time_horizon, decision_date,
      review_date, status, void_reason, voided_at, source_reference, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'effective', NULL, NULL, ?, ?, ?)`,
    (statement) => statement.run(
      projectId,
      values.decision,
      values.summary,
      values.rationale,
      values.timeHorizon,
      values.decisionDate,
      values.reviewDate,
      values.sourceReference,
      "2026-11-12T00:00:00.000Z",
      "2026-11-12T00:00:00.000Z",
    ),
  );
}

test("requires an explicit absolute file path and never creates parent directories", (t) => {
  const paths = tempPath();
  t.after(() => {});
  assert.throws(() => SQLiteDecisionStore.open(undefined), /databasePath/i);
  assert.throws(() => SQLiteDecisionStore.open({}), /databasePath/i);
  assert.throws(() => SQLiteDecisionStore.open({ databasePath: "" }), /absolute databasePath/i);
  assert.throws(() => SQLiteDecisionStore.open({ databasePath: "relative.sqlite" }), /absolute databasePath/i);
  assert.throws(() => SQLiteDecisionStore.open({ databasePath: ":memory:" }), /absolute databasePath/i);

  const missingParent = join(paths.root, "must-not-be-created");
  assert.throws(() => SQLiteDecisionStore.open({ databasePath: join(missingParent, "decisions.sqlite") }));
  assert.equal(existsSync(missingParent), false);
  assert.equal(existsSync(paths.databasePath), false);
});

test("initializes four tables, named indexes, user_version, and required connection pragmas", (t) => {
  const { store } = storeFor(t);
  const database = store.database;

  assert.equal(pragma(database, "user_version"), 1);
  assert.equal(String(pragma(database, "journal_mode")).toLowerCase(), "wal");
  assert.equal(pragma(database, "busy_timeout"), 5000);
  assert.equal(pragma(database, "foreign_keys"), 1);
  assert.equal(pragma(database, "synchronous"), 1);
  assert.equal(pragma(database, "cache_size"), -20000);
  assert.deepEqual(
    withStatement(database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      (statement) => statement.all().map((row) => row.name),
    ),
    ["decision_revisions", "decisions", "projects", "session_projects"],
  );
  const indexes = withStatement(database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    (statement) => statement.all().map((row) => row.name),
  );
  for (const index of [
    "uq_projects_project_key",
    "idx_projects_name",
    "uq_session_projects_session_id",
    "idx_session_projects_project_id",
    "idx_decisions_project_updated",
    "idx_decision_revisions_decision_created",
  ]) assert.ok(indexes.includes(index), `missing index ${index}`);
  const schemaSql = withStatement(database,
    "SELECT sql FROM sqlite_master WHERE type = 'table'",
    (statement) => statement.all().map((row) => row.sql).join("\\n"),
  );
  for (const constraint of [
    "ck_projects_key",
    "ck_projects_name",
    "ck_session_projects_session_id",
    "ck_decisions_revision",
    "ck_decisions_text",
    "ck_decisions_summary",
    "ck_decisions_rationale_length",
    "ck_decisions_time_horizon",
    "ck_decisions_decision_date",
    "ck_decisions_review_date",
    "ck_decisions_status",
    "ck_decisions_source_reference_length",
    "ck_decisions_void_state",
    "ck_decision_revisions_change_kind",
    "ck_decision_revisions_snapshot_json",
  ]) assert.match(schemaSql, new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK`, "i"));
  for (const foreignKey of [
    "fk_session_projects_project_id",
    "fk_decisions_project_id",
    "fk_decision_revisions_decision_id",
  ]) assert.match(schemaSql, new RegExp(`CONSTRAINT\\s+${foreignKey}\\s+FOREIGN\\s+KEY`, "i"));
  assert.deepEqual(withStatement(database, "PRAGMA foreign_key_check", (statement) => statement.all()), []);
});

test("database checks enforce project key/name and decision text/date constraints", (t) => {
  const { store } = storeFor(t);
  const database = store.database;
  assert.equal(dataOf(store.createProject({ name: "Atlas North", projectKey: "atlas-north" })).name, "Atlas North");

  assert.throws(() => insertRawProject(database, "Atlas", "Bad key"), /CHECK constraint failed/i);
  assert.throws(() => insertRawProject(database, "bad--key", "Bad key"), /CHECK constraint failed/i);
  assert.throws(() => insertRawProject(database, "name-control", "Bad\nName"), /CHECK constraint failed/i);
  assert.throws(() => insertRawProject(database, "name-space", "  Atlas  "), /CHECK constraint failed/i);
  assert.throws(() => insertRawProject(database, "name-too-long", "😀".repeat(65)), /CHECK constraint failed/i);

  const project = dataOf(store.getProjectByKey("atlas-north"));
  assert.ok(project);
  assert.throws(() => insertRawDecision(database, project.projectId, { decision: "  \u00a0\t " }), /CHECK constraint failed/i);
  assert.throws(() => insertRawDecision(database, project.projectId, { decision: "contains\u0000nul" }), /CHECK constraint failed/i);
  assert.throws(() => insertRawDecision(database, project.projectId, { decisionDate: "2023-02-29" }), /CHECK constraint failed/i);
  assert.throws(() => insertRawDecision(database, project.projectId, { decisionDate: "2024-02-30" }), /CHECK constraint failed/i);
  assert.equal(createDecision(store, project.projectId, "😀".repeat(20_000)).revision, 1);
});

test("foreign keys reject missing parents and database-local keys repeat across databases", (t) => {
  const first = storeFor(t);
  const secondPaths = tempPath();
  const second = SQLiteDecisionStore.open({ databasePath: secondPaths.databasePath });
  t.after(() => second.close());

  const a = createProject(first.store, "Atlas", "atlas");
  const b = createProject(second, "Atlas", "atlas");
  assert.equal(a.projectKey, b.projectKey);
  assert.equal(a.projectId, 1);
  assert.equal(b.projectId, 1);
  assert.equal(countRows(first.store.database, "projects"), 1);
  assert.equal(countRows(second.database, "projects"), 1);
  errorOf(first.store.createProject({ name: "Duplicate", projectKey: "atlas" }), "VALIDATION_FAILED", "projectKey");

  assert.throws(() => withStatement(first.store.database,
    "INSERT INTO session_projects (session_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    (statement) => statement.run("missing-project", 999, "2026-11-12T00:00:00.000Z", "2026-11-12T00:00:00.000Z"),
  ), /FOREIGN KEY constraint failed/i);
});

test("new project and session binding commit atomically; repeated same binding is idempotent", (t) => {
  const { store } = storeFor(t);
  const binding = dataOf(store.createAndBindProject("session-1", { name: "Atlas", projectKey: "atlas" }));
  assert.equal(binding.projectId, 1);
  assert.equal(dataOf(store.getBoundProject("session-1")).projectKey, "atlas");

  const same = dataOf(store.bindSession("session-1", binding.projectId));
  assert.equal(same.projectId, binding.projectId);
  errorOf(store.createAndBindProject("session-1", { name: "Other", projectKey: "other" }), "VALIDATION_FAILED", "sessionId");
  assert.equal(dataOf(store.listProjects()).length, 1);

  const second = dataOf(store.bindSession("session-2", binding.projectId));
  assert.equal(second.projectId, binding.projectId);
  errorOf(store.bindSession("session-3", 999), "PROJECT_REQUIRED");
  assert.equal(countRows(store.database, "session_projects"), 2);
});

test("failed project binding rolls back the newly inserted project", (t) => {
  const { store } = storeFor(t);
  store.database.exec(`CREATE TEMP TRIGGER fail_session_binding
    BEFORE INSERT ON session_projects
    BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END`);

  errorOf(store.createAndBindProject("session-fail", { name: "Atlas", projectKey: "atlas" }), "DATABASE_ERROR");
  assert.deepEqual(dataOf(store.listProjects()), []);
  assert.equal(dataOf(store.getBoundProject("session-fail")), null);
});

test("batch creation rolls back every row when an insert fails", (t) => {
  const { store } = storeFor(t);
  const project = createProject(store);
  store.database.exec(`CREATE TEMP TRIGGER fail_batch_item
    BEFORE INSERT ON decisions WHEN NEW.decision_text = 'fail this item'
    BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END`);

  errorOf(store.createDecisionsBatch(project.projectId, {
    decisions: [{ decision: "would have inserted" }, { decision: "fail this item" }],
  }), "DATABASE_ERROR");
  assert.equal(countRows(store.database, "decisions"), 0);
});

test("create/get/search use project scope and literal LIKE matching", (t) => {
  const { store } = storeFor(t);
  const projectA = createProject(store, "Alpha", "alpha");
  const projectB = createProject(store, "Beta", "beta");
  const created = createDecision(store, projectA.projectId, "Alpha contains 100%_ literal", {
    summary: "A literal summary",
    rationale: "Extra rationale",
    sourceReference: "source\\path",
  });
  const current = dataOf(store.getDecision(projectA.projectId, { decisionId: created.decisionId }));
  assert.equal(current.revision, 1);
  assert.equal(current.status, "effective");
  assert.equal(current.timeHorizon, "temporary");
  assert.equal(current.summary, "A literal summary");

  const literal = dataOf(store.searchDecisions(projectA.projectId, { query: "100%_" }));
  assert.equal(literal.decisions.length, 1);
  assert.equal(literal.decisions[0].decisionId, created.decisionId);
  assert.equal(dataOf(store.searchDecisions(projectA.projectId, { query: "100ZZ" })).decisions.length, 0);
  assert.equal(dataOf(store.searchDecisions(projectA.projectId, { query: "alpha" })).decisions.length, 1);
  assert.equal(dataOf(store.searchDecisions(projectA.projectId, { query: "source\\path" })).decisions.length, 1);

  const foreignGet = store.getDecision(projectB.projectId, { decisionId: created.decisionId });
  const missingGet = store.getDecision(projectB.projectId, { decisionId: 999 });
  errorOf(foreignGet, "DECISION_NOT_FOUND");
  assert.deepEqual(foreignGet, missingGet);
  const foreignUpdate = store.updateDecision(projectB.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    patch: { decision: "unauthorized" },
  });
  const missingUpdate = store.updateDecision(projectB.projectId, {
    decisionId: 999,
    expectedRevision: 1,
    patch: { decision: "unauthorized" },
  });
  errorOf(foreignUpdate, "DECISION_NOT_FOUND");
  assert.deepEqual(foreignUpdate, missingUpdate);
  const foreignVoid = store.voidDecision(projectB.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    reason: "unauthorized",
  });
  const missingVoid = store.voidDecision(projectB.projectId, {
    decisionId: 999,
    expectedRevision: 1,
    reason: "unauthorized",
  });
  errorOf(foreignVoid, "DECISION_NOT_FOUND");
  assert.deepEqual(foreignVoid, missingVoid);
  errorOf(store.getDecisionHistory(projectB.projectId, created.decisionId), "DECISION_NOT_FOUND");
  assert.equal(dataOf(store.searchDecisions(projectB.projectId, { query: "Alpha" })).decisions.length, 0);
});

test("search defaults to effective, pages results, and limits preview by code point", (t) => {
  const { store } = storeFor(t);
  const project = createProject(store);
  createDecision(store, project.projectId, "shared two");
  createDecision(store, project.projectId, "shared one", { summary: "😀".repeat(241) });
  const firstPage = dataOf(store.searchDecisions(project.projectId, { query: "shared", limit: 1 }));
  assert.equal(firstPage.decisions.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(Array.from(firstPage.decisions[0].preview).length, 240);

  const first = dataOf(store.getDecision(project.projectId, { decisionId: firstPage.decisions[0].decisionId }));
  dataOf(store.voidDecision(project.projectId, {
    decisionId: first.decisionId,
    expectedRevision: 1,
    reason: "not needed",
  }));
  assert.equal(dataOf(store.searchDecisions(project.projectId, { query: "shared" })).decisions.length, 1);
  assert.equal(dataOf(store.searchDecisions(project.projectId, { query: "shared", includeVoided: true })).decisions.length, 2);
});

test("update snapshots old revision; stale update/void and no-op have zero side effects", (t) => {
  const { store } = storeFor(t);
  const project = createProject(store);
  const created = createDecision(store, project.projectId, "original decision", { summary: "same summary" });
  const changed = dataOf(store.updateDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    patch: { decision: "updated decision" },
  }));
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.changedFields, ["decision"]);
  const afterUpdate = dataOf(store.getDecision(project.projectId, { decisionId: created.decisionId }));
  assert.equal(afterUpdate.updatedAt, changed.updatedAt);
  assert.ok(Date.parse(afterUpdate.updatedAt) > Date.parse(created.createdAt));
  let history = dataOf(store.getDecisionHistory(project.projectId, created.decisionId));
  assert.equal(history.length, 1);
  assert.equal(history[0].snapshot.revision, 1);
  assert.equal(history[0].snapshot.decision, "original decision");

  errorOf(store.updateDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    patch: { decision: "stale value" },
  }), "REVISION_CONFLICT");
  errorOf(store.voidDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    reason: "stale void",
  }), "REVISION_CONFLICT");
  const afterStale = dataOf(store.getDecision(project.projectId, { decisionId: created.decisionId }));
  assert.deepEqual(afterStale, afterUpdate);
  assert.equal(dataOf(store.getDecisionHistory(project.projectId, created.decisionId)).length, 1);

  const noOp = dataOf(store.updateDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 2,
    patch: { summary: "same summary" },
  }));
  assert.equal(noOp.revision, 2);
  assert.deepEqual(noOp.changedFields, []);
  assert.equal(noOp.updatedAt, afterUpdate.updatedAt);
  history = dataOf(store.getDecisionHistory(project.projectId, created.decisionId));
  assert.equal(history.length, 1);
});

test("void snapshots once, repeated matching void is idempotent, and voided updates are rejected", (t) => {
  const { store } = storeFor(t);
  const project = createProject(store);
  const created = createDecision(store, project.projectId, "to be voided");
  const firstVoid = dataOf(store.voidDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    reason: "  user requested  ",
  }));
  assert.equal(firstVoid.revision, 2);
  const voided = dataOf(store.getDecision(project.projectId, { decisionId: created.decisionId }));
  assert.equal(voided.status, "voided");
  assert.equal(voided.voidReason, "  user requested  ");
  assert.equal(voided.voidedAt, firstVoid.voidedAt);

  const historyBefore = dataOf(store.getDecisionHistory(project.projectId, created.decisionId));
  assert.equal(historyBefore.length, 1);
  assert.equal(historyBefore[0].changeKind, "void");
  assert.equal(historyBefore[0].snapshot.revision, 1);

  const repeated = dataOf(store.voidDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 2,
    reason: "different reason is ignored for an already voided record",
  }));
  assert.equal(repeated.revision, 2);
  assert.equal(repeated.voidedAt, firstVoid.voidedAt);
  errorOf(store.updateDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 2,
    patch: { decision: "cannot edit" },
  }), "DECISION_NOT_EDITABLE");
  errorOf(store.updateDecision(project.projectId, {
    decisionId: created.decisionId,
    expectedRevision: 1,
    patch: { decision: "stale cannot edit" },
  }), "REVISION_CONFLICT");
  assert.equal(dataOf(store.getDecisionHistory(project.projectId, created.decisionId)).length, 1);
});

test("schema preflight rejects incompatible DELETE-mode files without changing persistent state", (t) => {
  const assertPreservedAfterRefusal = (databasePath, messagePattern, expectedVersion, expectedTables, valueQuery) => {
    assert.throws(() => SQLiteDecisionStore.open({ databasePath }), messagePattern);
    const check = new DatabaseSync(databasePath);
    try {
      assert.equal(String(pragma(check, "journal_mode")).toLowerCase(), "delete");
      assert.equal(pragma(check, "user_version"), expectedVersion);
      assert.deepEqual(
        withStatement(check,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          (statement) => statement.all().map((row) => row.name),
        ),
        expectedTables,
      );
      if (valueQuery !== undefined) {
        assert.equal(withStatement(check, valueQuery, (statement) => statement.get().value), "preserve-me");
      }
    } finally {
      check.close();
    }
  };

  const unversioned = tempPath();
  const oldDatabase = new DatabaseSync(unversioned.databasePath);
  oldDatabase.exec("PRAGMA journal_mode = DELETE");
  oldDatabase.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  withStatement(oldDatabase, "INSERT INTO unrelated (value) VALUES (?)", (statement) => statement.run("preserve-me"));
  oldDatabase.close();
  assertPreservedAfterRefusal(
    unversioned.databasePath,
    /unversioned database/i,
    0,
    ["unrelated"],
    "SELECT value FROM unrelated LIMIT 1",
  );

  const unknownVersion = tempPath();
  const unknownDatabase = new DatabaseSync(unknownVersion.databasePath);
  unknownDatabase.exec("PRAGMA journal_mode = DELETE");
  unknownDatabase.exec("PRAGMA user_version = 99");
  unknownDatabase.close();
  assertPreservedAfterRefusal(unknownVersion.databasePath, /unsupported database schema version/i, 99, []);

  const wrongSchema = tempPath();
  const wrongSchemaDatabase = new DatabaseSync(wrongSchema.databasePath);
  wrongSchemaDatabase.exec("PRAGMA journal_mode = DELETE");
  wrongSchemaDatabase.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  withStatement(wrongSchemaDatabase, "INSERT INTO unrelated (value) VALUES (?)", (statement) => statement.run("preserve-me"));
  wrongSchemaDatabase.exec("PRAGMA user_version = 1");
  wrongSchemaDatabase.close();
  assertPreservedAfterRefusal(
    wrongSchema.databasePath,
    /schema does not match/i,
    1,
    ["unrelated"],
    "SELECT value FROM unrelated LIMIT 1",
  );

  const missingIndexes = tempPath();
  const missingIndexDatabase = new DatabaseSync(missingIndexes.databasePath);
  missingIndexDatabase.exec("PRAGMA journal_mode = DELETE");
  missingIndexDatabase.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    CREATE TABLE session_projects (id INTEGER PRIMARY KEY);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY);
    CREATE TABLE decision_revisions (id INTEGER PRIMARY KEY);
    PRAGMA user_version = 1;
  `);
  missingIndexDatabase.close();
  assertPreservedAfterRefusal(
    missingIndexes.databasePath,
    /missing one or more required decision-store indexes/i,
    1,
    ["decision_revisions", "decisions", "projects", "session_projects"],
  );

  const foreignKeyViolation = tempPath();
  const validStore = SQLiteDecisionStore.open({ databasePath: foreignKeyViolation.databasePath });
  validStore.close();
  const corrupted = new DatabaseSync(foreignKeyViolation.databasePath);
  corrupted.exec("PRAGMA foreign_keys = OFF");
  corrupted.exec("PRAGMA journal_mode = DELETE");
  withStatement(corrupted,
    "INSERT INTO session_projects (session_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    (statement) => statement.run("preserve-me", 999, "2026-11-12T00:00:00.000Z", "2026-11-12T00:00:00.000Z"),
  );
  corrupted.close();
  assertPreservedAfterRefusal(
    foreignKeyViolation.databasePath,
    /foreign key violations/i,
    1,
    ["decision_revisions", "decisions", "projects", "session_projects"],
    "SELECT session_id AS value FROM session_projects LIMIT 1",
  );
});
