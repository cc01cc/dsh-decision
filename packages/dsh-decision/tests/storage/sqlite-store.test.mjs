import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("initializes six tables, named indexes, user_version, and required connection pragmas", (t) => {
  const { store } = storeFor(t);
  const database = store.database;

  assert.equal(pragma(database, "user_version"), 3);
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
    ["decision_refs", "decision_replaces", "decision_revisions", "decisions", "projects", "session_projects"],
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
    "uq_decisions_external_id",
    "uq_decision_refs_edge",
    "idx_decision_refs_reverse",
    "uq_decision_replaces_edge",
    "idx_decision_replaces_reverse",
  ]) assert.ok(indexes.includes(index), `missing index ${index}`);
  const schemaSql = withStatement(database,
    "SELECT sql FROM sqlite_master WHERE type = 'table'",
    (statement) => statement.all().map((row) => row.sql).join("\\n"),
  );
  // STRICT is used when the runtime supports it (SQLite >= 3.37); the runtime
  // version is probed at open time, not assumed.
  const sqliteVersion = String(withStatement(database,
    "SELECT sqlite_version() AS version",
    (statement) => statement.get().version,
  ));
  const strictSupported = Number(sqliteVersion.split(".")[0]) > 3
    || (Number(sqliteVersion.split(".")[0]) === 3 && Number(sqliteVersion.split(".")[1]) >= 37);
  assert.equal(strictSupported, true, `unexpected SQLite version ${sqliteVersion}`);
  for (const table of ["projects", "session_projects", "decisions", "decision_revisions", "decision_refs", "decision_replaces"]) {
    assert.match(schemaSql, new RegExp(`CREATE TABLE \\b${table}\\b ([\\s\\S]*?)\\)\\s*STRICT`, "i"));
  }
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
    "ck_decisions_external_id",
    "ck_decisions_replaces_json",
    "ck_decision_refs_type",
    "ck_decision_refs_key",
  ]) assert.match(schemaSql, new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK`, "i"));
  for (const foreignKey of [
    "fk_session_projects_project_id",
    "fk_decisions_project_id",
    "fk_decision_revisions_decision_id",
    "fk_decision_refs_decision_id",
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

test("decision text length checks count original code points, not trimmed length", (t) => {
  const { store } = storeFor(t);
  const database = store.database;
  const project = createProject(store);

  // Padded original text is stored verbatim and stays within the raw limit.
  const padded = createDecision(store, project.projectId, "  padded decision text  ");
  const stored = dataOf(store.getDecision(project.projectId, { decisionId: padded.decisionId }));
  assert.equal(stored.decision, "  padded decision text  ");

  // A raw 20,008-code-point value whose trimmed length is 19,998 used to pass
  // a trim-based CHECK; the frozen contract counts original code points.
  const paddedOverLimit = " ".repeat(5) + "a".repeat(19_998) + " ".repeat(5);
  assert.equal(Array.from(paddedOverLimit).length, 20_008);
  assert.throws(() => insertRawDecision(database, project.projectId, { decision: paddedOverLimit }), /CHECK constraint failed/i);

  // Exactly 20,000 original code points with interior whitespace is accepted.
  const atLimit = ("a ".repeat(10_000)).slice(0, 20_000);
  assert.equal(Array.from(atLimit).length, 20_000);
  insertRawDecision(database, project.projectId, { decision: atLimit });

  // summary: 302 original code points, trimmed 300 — rejected.
  const summaryOverLimit = " ".repeat(1) + "s".repeat(300) + " ".repeat(1);
  assert.throws(() => insertRawDecision(database, project.projectId, { decision: "ok", summary: summaryOverLimit }), /CHECK constraint failed/i);
  // source_reference: 4,002 original code points, trimmed 4,000 — rejected.
  const sourceOverLimit = " ".repeat(1) + "r".repeat(4_000) + " ".repeat(1);
  assert.throws(() => insertRawDecision(database, project.projectId, { decision: "ok", sourceReference: sourceOverLimit }), /CHECK constraint failed/i);

  // void_reason: 1,002 original code points, trimmed 1,000 — rejected on a raw voided row.
  const reasonOverLimit = " ".repeat(1) + "v".repeat(1_000) + " ".repeat(1);
  assert.throws(() => withStatement(database,
    `INSERT INTO decisions (
      project_id, decision_text, summary, rationale, time_horizon, decision_date,
      review_date, status, void_reason, voided_at, source_reference, created_at, updated_at
    ) VALUES (?, 'ok', NULL, NULL, 'temporary', NULL, NULL, 'voided', ?, ?, NULL, ?, ?)`,
    (statement) => statement.run(project.projectId, reasonOverLimit, "2026-11-13T00:00:00.000Z", "2026-11-13T00:00:00.000Z", "2026-11-13T00:00:00.000Z"),
  ), /CHECK constraint failed/i);
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
  // task-377 ④: omitting timeHorizon now defaults to long_term (requirements
  // §10.5); the frozen domain parser's historical temporary default is
  // overridden at the store boundary.
  assert.equal(current.timeHorizon, "long_term");
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

test("schema preflight rejects incompatible DELETE-mode files without changing persistent state", (_t) => {
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
    3,
    ["decision_refs", "decision_replaces", "decision_revisions", "decisions", "projects", "session_projects"],
    "SELECT session_id AS value FROM session_projects LIMIT 1",
  );
});

// ---------------------------------------------------------------------------
// task-377: v1 -> v2 migration. The fixture is the exact schema the pre-task-377
// store created (see fixtures/v1-schema.sql provenance header).
// ---------------------------------------------------------------------------

const V1_SCHEMA_SQL = readFileSync(new URL("./fixtures/v1-schema.sql", import.meta.url), "utf8");
const V1_DECISION_COLUMNS = "id, revision, project_id, decision_text, summary, rationale, time_horizon, decision_date, review_date, status, void_reason, voided_at, source_reference, created_at, updated_at";

function seedV1Database(databasePath) {
  const seed = new DatabaseSync(databasePath);
  seed.exec(V1_SCHEMA_SQL);
  seed.exec("PRAGMA user_version = 1");
  seed.exec(`
    INSERT INTO projects (project_key, name, created_at, updated_at)
      VALUES ('atlas', 'Atlas', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    INSERT INTO session_projects (session_id, project_id, created_at, updated_at)
      VALUES ('sess-1', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    INSERT INTO decisions (project_id, decision_text, summary, rationale, time_horizon,
      decision_date, review_date, status, void_reason, voided_at, source_reference, created_at, updated_at)
      VALUES (1, 'v1 effective decision', 'v1 summary', 'v1 rationale', 'temporary',
        '2026-11-01', '2026-12-01', 'effective', NULL, NULL, 'ledger D-1',
        '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    INSERT INTO decisions (project_id, decision_text, summary, rationale, time_horizon,
      decision_date, review_date, status, void_reason, voided_at, source_reference, created_at, updated_at)
      VALUES (1, 'v1 voided decision', NULL, NULL, 'long_term',
        NULL, NULL, 'voided', 'superseded by D-2', '2026-11-03T00:00:00.000Z', NULL,
        '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    UPDATE decisions SET revision = 3 WHERE id = 2;
    INSERT INTO decision_revisions (decision_id, change_kind, snapshot_json, created_at)
      VALUES (2, 'update', '{"decisionId":2,"revision":1}', '2026-11-02T00:00:00.000Z');
    INSERT INTO decision_revisions (decision_id, change_kind, snapshot_json, created_at)
      VALUES (2, 'void', '{"decisionId":2,"revision":2}', '2026-11-03T00:00:00.000Z');
  `);
  return seed;
}

function dumpV1Rows(database) {
  return {
    projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
    sessions: database.prepare("SELECT * FROM session_projects ORDER BY id").all(),
    decisions: database.prepare(`SELECT ${V1_DECISION_COLUMNS} FROM decisions ORDER BY id`).all(),
    revisions: database.prepare("SELECT * FROM decision_revisions ORDER BY id").all(),
  };
}

test("v1 database migrates to v3 in place, preserving every stored row", (t) => {
  const paths = tempPath();
  const seed = seedV1Database(paths.databasePath);
  const before = dumpV1Rows(seed);
  seed.close();

  const store = SQLiteDecisionStore.open({ databasePath: paths.databasePath });
  t.after(() => store.close());
  const database = store.database;

  assert.equal(pragma(database, "user_version"), 3, "open migrates v1 straight to v3 (one transaction)");
  assert.deepEqual(
    withStatement(database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      (statement) => statement.all().map((row) => row.name),
    ),
    ["decision_refs", "decision_replaces", "decision_revisions", "decisions", "projects", "session_projects"],
  );
  const indexes = withStatement(database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    (statement) => statement.all().map((row) => row.name),
  );
  for (const index of [
    "uq_decisions_external_id",
    "uq_decision_refs_edge",
    "idx_decision_refs_reverse",
    "uq_decision_replaces_edge",
    "idx_decision_replaces_reverse",
  ]) {
    assert.ok(indexes.includes(index), `missing migrated index ${index}`);
  }
  assert.deepEqual(dumpV1Rows(database), before, "migration must not rewrite any stored v1 row");
  assert.deepEqual(
    database.prepare("SELECT external_id, replaces_json FROM decisions ORDER BY id").all()
      .map((row) => ({ external_id: row.external_id, replaces_json: row.replaces_json })),
    [{ external_id: null, replaces_json: null }, { external_id: null, replaces_json: null }],
    "new columns start NULL on migrated rows",
  );

  // Reopening a migrated database does not migrate again.
  const reopened = SQLiteDecisionStore.open({ databasePath: paths.databasePath });
  try {
    assert.equal(pragma(reopened.database, "user_version"), 3);
    assert.deepEqual(dumpV1Rows(reopened.database), before);
  } finally {
    reopened.close();
  }

  // v1 values survive through the store's read face, including the explicit
  // temporary horizon (the new default must not rewrite stored rows).
  const got = dataOf(store.getDecision(1, { decisionId: 1 }));
  assert.equal(got.decision, "v1 effective decision");
  assert.equal(got.timeHorizon, "temporary");
  assert.equal(got.externalId, null);
  assert.equal(got.replaces, null);
  assert.equal(dataOf(store.getDecisionHistory(1, 2)).length, 2, "revision history intact");

  // The migrated database accepts the new write faces.
  const created = dataOf(store.createDecision(1, {
    decision: "post-migration",
    externalId: "D-9001",
    refs: [{ type: "task", id: "T-1" }],
    replaces: [1],
  }));
  assert.equal(created.alreadyExisted, false);
  const again = dataOf(store.createDecision(1, { decision: "duplicate attempt", externalId: "D-9001" }));
  assert.equal(again.decisionId, created.decisionId);
  assert.equal(again.alreadyExisted, true);
  // task-615: a v1 file has no replaces declaration, so the v2->v3 backfill adds
  // nothing; a post-migration create then writes the projection in the same
  // transaction as the declaration.
  const projection = withStatement(database,
    "SELECT decision_id, replaced_id FROM decision_replaces ORDER BY decision_id, replaced_id",
    (statement) => statement.all().map((row) => [row.decision_id, row.replaced_id]),
  );
  assert.deepEqual(projection, [[created.decisionId, 1]], "only the newly declared edge is in the projection");
  const reverse = dataOf(store.searchDecisions(1, { replacedDecisionId: 1 }));
  assert.deepEqual(reverse.decisions.map((d) => d.decisionId), [created.decisionId]);
});

test("v2 database migrates to v3 and backfills decision_replaces from the authority", (t) => {
  const paths = tempPath();
  // Build a v3 database first (the only writer that can seed replaces), then
  // strip exactly what v2->v3 adds and set the version back to 2. The v2->v3
  // migration is additive only (one table + two indexes), so this reproduces the
  // v2 shape faithfully; the pre-v3 store binary is not available here, and the
  // real v1 fixture above covers the "genuine old file" path.
  const seedStore = SQLiteDecisionStore.open({ databasePath: paths.databasePath });
  seedStore.createProject({ name: "Atlas", projectKey: "atlas" });
  const oldA = dataOf(seedStore.createDecision(1, { decision: "old A" }));
  const oldB = dataOf(seedStore.createDecision(1, { decision: "old B" }));
  const newer = dataOf(seedStore.createDecision(1, {
    decision: "newer ruling",
    replaces: [oldA.decisionId, oldB.decisionId],
  }));
  seedStore.close();

  const raw = new DatabaseSync(paths.databasePath);
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec(`
    DROP INDEX uq_decision_replaces_edge;
    DROP INDEX idx_decision_replaces_reverse;
    DROP TABLE decision_replaces;
    PRAGMA user_version = 2;
  `);
  raw.close();

  const store = SQLiteDecisionStore.open({ databasePath: paths.databasePath });
  t.after(() => store.close());
  const database = store.database;
  assert.equal(pragma(database, "user_version"), 3, "a v2 file upgrades to v3 on open");
  const pairs = withStatement(database,
    "SELECT decision_id, replaced_id, created_at FROM decision_replaces ORDER BY decision_id, replaced_id",
    (statement) => statement.all(),
  );
  assert.deepEqual(
    pairs.map((row) => [row.decision_id, row.replaced_id]),
    [[newer.decisionId, oldA.decisionId], [newer.decisionId, oldB.decisionId]],
    "the projection is backfilled from replaces_json",
  );
  assert.equal(pairs[0].created_at, newer.createdAt, "backfill keeps the declarer's own created_at, not the migration time");
  // The authority is untouched by the migration.
  assert.deepEqual(dataOf(store.getDecision(1, { decisionId: newer.decisionId })).replaces, [oldA.decisionId, oldB.decisionId]);
  // And the reverse query works against the backfilled rows.
  const hits = dataOf(store.searchDecisions(1, { replacedDecisionId: oldA.decisionId }));
  assert.deepEqual(hits.decisions.map((d) => d.decisionId), [newer.decisionId]);
});

test("a v2 file with an unexpected shape is refused before any ALTER", (_t) => {
  const paths = tempPath();
  const seedStore = SQLiteDecisionStore.open({ databasePath: paths.databasePath });
  seedStore.createProject({ name: "Atlas", projectKey: "atlas" });
  dataOf(seedStore.createDecision(1, { decision: "old" }));
  seedStore.close();

  const raw = new DatabaseSync(paths.databasePath);
  // Reproduce the v2 shape (additive-only migration), then remove one index v2
  // must have: the file is now "v2 by number, not v2 by shape".
  raw.exec(`DROP INDEX uq_decision_replaces_edge; DROP INDEX idx_decision_replaces_reverse; DROP TABLE decision_replaces; PRAGMA user_version = 2;`);
  raw.exec("DROP INDEX idx_decision_refs_reverse");
  raw.close();

  assert.throws(
    () => SQLiteDecisionStore.open({ databasePath: paths.databasePath }),
    /missing one or more required decision-store indexes/i,
  );
  const after = new DatabaseSync(paths.databasePath);
  try {
    assert.equal(pragma(after, "user_version"), 2, "the refused open did not move the version");
    assert.equal(
      after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'decision_replaces'").get().n,
      0,
      "nothing was created on a foreign file",
    );
    assert.equal(after.prepare("SELECT count(*) AS n FROM decisions").get().n, 1, "stored rows untouched");
  } finally {
    after.close();
  }
});

test("a failed v1 migration rolls back completely and leaves the file at v1", (_t) => {
  const paths = tempPath();
  const seed = seedV1Database(paths.databasePath);
  // An object that already owns one of the migration's index names makes the
  // migration fail mid-transaction (preflight allows extra v1 indexes).
  seed.exec("CREATE UNIQUE INDEX uq_decisions_external_id ON decisions(id)");
  const before = dumpV1Rows(seed);
  seed.close();

  assert.throws(() => SQLiteDecisionStore.open({ databasePath: paths.databasePath }), /already exists/i);

  const check = new DatabaseSync(paths.databasePath);
  try {
    assert.equal(pragma(check, "user_version"), 1, "version must not advance on failure");
    const columns = check.prepare("SELECT name FROM pragma_table_info('decisions') ORDER BY cid").all().map((row) => row.name);
    assert.equal(columns.length, 15, "no partial column may survive the rollback");
    assert.ok(!columns.includes("external_id"));
    assert.ok(!columns.includes("replaces_json"));
    const tables = withStatement(check,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      (statement) => statement.all().map((row) => row.name),
    );
    assert.ok(!tables.includes("decision_refs"), "no partial table may survive the rollback");
    assert.deepEqual(dumpV1Rows(check), before, "stored rows untouched by the failed migration");
  } finally {
    check.close();
  }
});
