import { DatabaseSync } from "node:sqlite";
import { isAbsolute, parse } from "node:path";
import {
  parseDecisionCreateBatchInput,
  parseDecisionCreateInput,
  parseDecisionGetInput,
  parseDecisionSearchInput,
  parseDecisionUpdateInput,
  parseDecisionVoidInput,
  parseProjectInput,
  parseProjectKey,
} from "../domain/decision-contract.ts";
import type {
  DecisionCreateInput,
  DecisionGetInput,
  DecisionRecord,
  DecisionSearchInput,
  DecisionStatus,
  DecisionUpdateInput,
  DecisionVoidInput,
  DomainErrorCode,
  DomainResult,
  ProjectInput,
  TimeHorizon,
} from "../domain/decision-contract.ts";

const SCHEMA_VERSION = 1;
const UNICODE_WHITE_SPACE_SQL = "char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288)";

export interface SQLiteDecisionStoreOptions {
  databasePath: string;
}

export interface ProjectRecord {
  projectId: number;
  name: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBindingRecord extends ProjectRecord {
  sessionId: string;
}

export interface DecisionSearchItem {
  decisionId: number;
  preview: string;
  status: DecisionStatus;
}

export interface DecisionSearchPage {
  decisions: DecisionSearchItem[];
  hasMore: boolean;
}

export interface DecisionCreateReceipt {
  decisionId: number;
  revision: 1;
  summary: string | null;
  status: "effective";
  createdAt: string;
}

export interface DecisionBatchReceipt {
  createdCount: number;
  decisions: Array<{ index: number; decisionId: number; revision: 1 }>;
}

export interface DecisionUpdateReceipt {
  decisionId: number;
  revision: number;
  changedFields: string[];
  status: "effective";
  updatedAt: string;
}

export interface DecisionVoidReceipt {
  decisionId: number;
  revision: number;
  status: "voided";
  voidedAt: string;
}

export interface DecisionRevisionRecord {
  revisionId: number;
  decisionId: number;
  changeKind: "update" | "void";
  snapshot: DecisionRecord;
  createdAt: string;
}

interface ProjectRow {
  projectId: number;
  name: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
}

interface DecisionRow {
  decisionId: number;
  revision: number;
  projectId: number;
  decision: string;
  summary: string | null;
  rationale: string | null;
  timeHorizon: TimeHorizon;
  decisionDate: string | null;
  reviewDate: string | null;
  status: DecisionStatus;
  voidReason: string | null;
  voidedAt: string | null;
  sourceReference: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RevisionRow {
  revisionId: number;
  decisionId: number;
  changeKind: "update" | "void";
  snapshotJson: string;
  createdAt: string;
}

type Statement = ReturnType<DatabaseSync["prepare"]>;
type BindValue = string | number | bigint | null;

// Node v24.21.0 has no StatementSync.close()/Symbol.dispose(); prepared statements
// stay cached for this connection and DatabaseSync.close() owns connection teardown.
const statementCache = new WeakMap<DatabaseSync, Map<string, Statement>>();

function failure<T>(code: DomainErrorCode, message: string, field?: string, itemIndex?: number): DomainResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(field === undefined ? {} : { field }),
      ...(itemIndex === undefined ? {} : { itemIndex }),
    },
  };
}

function validationFailure<T>(field: string, message: string): DomainResult<T> {
  return failure("VALIDATION_FAILED", message, field);
}

function parserFailure<T>(result: DomainResult<unknown>): DomainResult<T> {
  if (result.ok) throw new TypeError("Expected a failed domain parse result.");
  return { ok: false, error: result.error };
}

function parsePositiveSafeInteger(value: unknown, field: string): DomainResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return validationFailure(field, "Expected a positive safe integer.");
  }
  return { ok: true, data: value };
}

function validateSessionId(value: unknown): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return validationFailure("sessionId", "Expected a non-empty session identifier.");
  }
  return { ok: true, data: value };
}

function timestamp(): string {
  return new Date().toISOString();
}

function prepare(database: DatabaseSync, sql: string): Statement {
  let cache = statementCache.get(database);
  if (cache === undefined) {
    cache = new Map<string, Statement>();
    statementCache.set(database, cache);
  }
  let statement = cache.get(sql);
  if (statement === undefined) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function one<T>(database: DatabaseSync, sql: string, values: readonly BindValue[] = []): T | undefined {
  return prepare(database, sql).get(...values) as T | undefined;
}

function many<T>(database: DatabaseSync, sql: string, values: readonly BindValue[] = []): T[] {
  return prepare(database, sql).all(...values) as T[];
}

function run(database: DatabaseSync, sql: string, values: readonly BindValue[] = []): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return prepare(database, sql).run(...values);
}

function scalar<T>(database: DatabaseSync, sql: string): T {
  const row = one<Record<string, T>>(database, sql);
  if (row === undefined) throw new Error("Expected a PRAGMA result row.");
  const first = Object.values(row)[0];
  if (first === undefined) throw new Error("Expected a PRAGMA result value.");
  return first;
}

function toSafeId(value: number | bigint): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new RangeError("SQLite returned an identifier outside the supported safe-integer range.");
  }
  return numeric;
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.projectId,
    name: row.name,
    projectKey: row.projectKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    decisionId: row.decisionId,
    revision: row.revision,
    summary: row.summary,
    decision: row.decision,
    rationale: row.rationale,
    timeHorizon: row.timeHorizon,
    decisionDate: row.decisionDate,
    reviewDate: row.reviewDate,
    status: row.status,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    sourceReference: row.sourceReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function decisionSelect(where: string): string {
  return `SELECT
    id AS decisionId,
    revision,
    project_id AS projectId,
    decision_text AS decision,
    summary,
    rationale,
    time_horizon AS timeHorizon,
    decision_date AS decisionDate,
    review_date AS reviewDate,
    status,
    void_reason AS voidReason,
    voided_at AS voidedAt,
    source_reference AS sourceReference,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM decisions ${where}`;
}

function checkNoNul(column: string): string {
  return `instr(CAST(${column} AS BLOB), X'00') = 0`;
}

function checkNoControls(column: string): string {
  const controls = [
    ...Array.from({ length: 31 }, (_, index) => index + 1),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ];
  return controls.map((codePoint) => `instr(${column}, char(${codePoint})) = 0`).join(" AND ");
}

function checkText(column: string, min: number, max: number): string {
  // The frozen contract counts stored text in Unicode code points (SQLite
  // length() on TEXT); trimming is only the non-blank test, so leading or
  // trailing White_Space must not consume the length budget.
  return `(${column} IS NULL OR (
    length(${column}) BETWEEN ${min} AND ${max}
    AND length(trim(${column}, ${UNICODE_WHITE_SPACE_SQL})) > 0
    AND ${checkNoNul(column)}
  ))`;
}

function checkDate(column: string): string {
  return `(${column} IS NULL OR (
    length(${column}) = 10
    AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(${column}, 1, 4) <> '0000'
    AND strftime('%Y-%m-%d', ${column}, '+0 days') IS NOT NULL
    AND strftime('%Y-%m-%d', ${column}, '+0 days') = ${column}
  ))`;
}

const SCHEMA_SQL = `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL CONSTRAINT ck_projects_key CHECK (
    length(project_key) BETWEEN 1 AND 48
    AND project_key NOT GLOB '*[^a-z0-9-]*'
    AND substr(project_key, 1, 1) <> '-'
    AND substr(project_key, -1, 1) <> '-'
    AND instr(project_key, '--') = 0
  ),
  name TEXT NOT NULL CONSTRAINT ck_projects_name CHECK (
    length(trim(name, ${UNICODE_WHITE_SPACE_SQL})) BETWEEN 1 AND 64
    AND name = trim(name, ${UNICODE_WHITE_SPACE_SQL})
    AND ${checkNoNul("name")}
    AND ${checkNoControls("name")}
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)__STRICT__;

CREATE UNIQUE INDEX uq_projects_project_key ON projects(project_key);
CREATE INDEX idx_projects_name ON projects(name);

CREATE TABLE session_projects (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL CONSTRAINT ck_session_projects_session_id
    CHECK (length(session_id) > 0 AND ${checkNoNul("session_id")}),
  project_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT fk_session_projects_project_id
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
)__STRICT__;
CREATE UNIQUE INDEX uq_session_projects_session_id ON session_projects(session_id);
CREATE INDEX idx_session_projects_project_id ON session_projects(project_id);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_decisions_revision CHECK (revision > 0),
  project_id INTEGER NOT NULL,
  decision_text TEXT NOT NULL CONSTRAINT ck_decisions_text CHECK (
    length(decision_text) BETWEEN 1 AND 20000
    AND length(trim(decision_text, ${UNICODE_WHITE_SPACE_SQL})) > 0
    AND ${checkNoNul("decision_text")}
  ),
  summary TEXT CONSTRAINT ck_decisions_summary CHECK (${checkText("summary", 1, 300)}),
  rationale TEXT CONSTRAINT ck_decisions_rationale_length CHECK (${checkText("rationale", 1, 20000)}),
  time_horizon TEXT NOT NULL DEFAULT 'temporary'
    CONSTRAINT ck_decisions_time_horizon CHECK (time_horizon IN ('long_term', 'temporary')),
  decision_date TEXT CONSTRAINT ck_decisions_decision_date CHECK (${checkDate("decision_date")}),
  review_date TEXT CONSTRAINT ck_decisions_review_date CHECK (${checkDate("review_date")}),
  status TEXT NOT NULL DEFAULT 'effective'
    CONSTRAINT ck_decisions_status CHECK (status IN ('effective', 'voided')),
  void_reason TEXT,
  voided_at TEXT,
  source_reference TEXT CONSTRAINT ck_decisions_source_reference_length CHECK (${checkText("source_reference", 1, 4000)}),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT ck_decisions_void_state CHECK (
    (status = 'effective' AND void_reason IS NULL AND voided_at IS NULL)
    OR
    (status = 'voided' AND void_reason IS NOT NULL
      AND length(void_reason) BETWEEN 1 AND 1000
      AND length(trim(void_reason, ${UNICODE_WHITE_SPACE_SQL})) > 0
      AND ${checkNoNul("void_reason")}
      AND voided_at IS NOT NULL)
  ),
  CONSTRAINT fk_decisions_project_id
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
)__STRICT__;
CREATE INDEX idx_decisions_project_updated ON decisions(project_id, updated_at DESC, id DESC);

CREATE TABLE decision_revisions (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL,
  change_kind TEXT NOT NULL CONSTRAINT ck_decision_revisions_change_kind
    CHECK (change_kind IN ('update', 'void')),
  snapshot_json TEXT NOT NULL CONSTRAINT ck_decision_revisions_snapshot_json
    CHECK (length(snapshot_json) > 0 AND ${checkNoNul("snapshot_json")}),
  created_at TEXT NOT NULL,
  CONSTRAINT fk_decision_revisions_decision_id
    FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE RESTRICT
)__STRICT__;
CREATE INDEX idx_decision_revisions_decision_created
  ON decision_revisions(decision_id, created_at DESC, id DESC);
`;

// SQLite 3.37+ parses the STRICT table suffix; older libraries must keep the
// plain schema. The runtime is probed instead of assumed.
function sqliteSupportsStrictTables(database: DatabaseSync): boolean {
  const version = String(scalar<string>(database, "SELECT sqlite_version() AS version"));
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error("Could not determine the SQLite library version.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 37);
}

function schemaSql(strict: boolean): string {
  return SCHEMA_SQL.replaceAll("__STRICT__", strict ? "STRICT" : "");
}

function schemaTableNames(database: DatabaseSync): string[] {
  return many<{ name: string }>(database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
}

function schemaIndexNames(database: DatabaseSync): string[] {
  return many<{ name: string }>(database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
}

const EXPECTED_TABLES = ["decision_revisions", "decisions", "projects", "session_projects"];
const EXPECTED_INDEXES = [
  "idx_decision_revisions_decision_created",
  "idx_decisions_project_updated",
  "idx_projects_name",
  "idx_session_projects_project_id",
  "uq_projects_project_key",
  "uq_session_projects_session_id",
];

function assertForeignKeyIntegrity(database: DatabaseSync): void {
  const violations = many<{ table: string; rowid: number | null; parent: string; fkid: number }>(
    database,
    "PRAGMA foreign_key_check",
  );
  if (violations.length > 0) {
    throw new Error("Database contains foreign key violations.");
  }
}

function assertSchemaShape(database: DatabaseSync): void {
  const tables = schemaTableNames(database);
  if (tables.length !== EXPECTED_TABLES.length || EXPECTED_TABLES.some((name, index) => tables[index] !== name)) {
    throw new Error("Database schema does not match the supported decision-store tables.");
  }
  const indexes = schemaIndexNames(database);
  if (EXPECTED_INDEXES.some((name) => !indexes.includes(name))) {
    throw new Error("Database is missing one or more required decision-store indexes.");
  }
  assertForeignKeyIntegrity(database);
}

function preflightSchema(database: DatabaseSync): number {
  const version = scalar<number>(database, "PRAGMA user_version");
  const tables = schemaTableNames(database);
  const indexes = schemaIndexNames(database);

  if (version === 0) {
    if (tables.length > 0 || indexes.length > 0) {
      throw new Error("Refusing to initialize an unversioned database containing application schema objects.");
    }
    return 0;
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported database schema version ${version}.`);
  }
  assertSchemaShape(database);
  return version;
}

function initializeSchema(database: DatabaseSync, version: number): void {
  if (version === 0) {
    const strict = sqliteSupportsStrictTables(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(schemaSql(strict));
      assertForeignKeyIntegrity(database);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original schema error. */ }
      throw error;
    }
    database.exec("PRAGMA optimize");
  }
  assertSchemaShape(database);
}

/**
 * Fail-closed Config gate shared by the store and the Host Config resolver.
 * Never falls back to $DSH_HOME, process.cwd(), or any shared root, and never
 * creates parent directories.
 */
export function validateDatabasePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || !isAbsolute(value)) {
    throw new TypeError("An explicit absolute databasePath is required; Profile path resolution is not provided by this store.");
  }
  if (process.platform === "win32" && parse(value).root.length <= 1) {
    throw new TypeError("An explicit absolute databasePath is required; a drive-less rooted path would resolve against process.cwd().");
  }
  if (value === ":memory:") {
    throw new TypeError("This store requires an explicit file path; in-memory databases are not a Profile store.");
  }
  return value;
}

function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA cache_size = -20000");

    if (scalar<number>(database, "PRAGMA busy_timeout") !== 5000) {
      throw new Error("SQLite busy_timeout could not be configured.");
    }
    if (scalar<number>(database, "PRAGMA foreign_keys") !== 1) {
      throw new Error("SQLite foreign key enforcement could not be enabled.");
    }
    if (scalar<number>(database, "PRAGMA synchronous") !== 1) {
      throw new Error("SQLite synchronous=NORMAL could not be configured.");
    }
    if (scalar<number>(database, "PRAGMA cache_size") !== -20000) {
      throw new Error("SQLite cache_size could not be configured.");
    }

    // WAL changes the database file persistently, so validate its recorded schema first.
    const schemaVersion = preflightSchema(database);
    database.exec("PRAGMA journal_mode = WAL");
    if (String(scalar<string>(database, "PRAGMA journal_mode")).toLowerCase() !== "wal") {
      throw new Error("SQLite WAL mode is not available for the supplied database path.");
    }

    initializeSchema(database, schemaVersion);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* Keep the configuration/schema error. */ }
    statementCache.delete(database);
    throw error;
  }
}

function sqliteFailure<T>(error: unknown): DomainResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message)) {
    return failure("DATABASE_BUSY", "Database is temporarily busy.");
  }
  return failure("DATABASE_ERROR", "Database operation failed.");
}

function isProjectKeyUniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: projects\.project_key/i.test(message);
}

/**
 * Wall-clock ISO timestamp (millisecond precision).
 *
 * Used for values that are only displayed, never ordered on: `created_at` of a
 * project, a session binding, or a decision.
 */
function nowIso(): string {
  return new Date().toISOString();
}


function escapeLikeLiteral(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

/** Contract §3 search: preview is the summary when present, else the decision
 * text, truncated to 240 Unicode code points. */
function previewText(content: string): string {
  return Array.from(content).slice(0, 240).join("");
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.projectId,
    name: row.name,
    projectKey: row.projectKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SQLiteDecisionStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private closed = false;

  private constructor(databasePath: string, database: DatabaseSync) {
    this.databasePath = databasePath;
    this.database = database;
  }

  static open(options: unknown): SQLiteDecisionStore {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Store options must be an object containing databasePath.");
    }
    const databasePath = validateDatabasePath((options as Record<string, unknown>).databasePath);
    const database = openDatabase(databasePath);
    return new SQLiteDecisionStore(databasePath, database);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    statementCache.delete(this.database);
    this.closed = true;
  }

  createProject(input: unknown): DomainResult<ProjectRecord> {
    const parsed = parseProjectInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();
    const createdAt = nowIso();
    try {
      return this.transaction(() => {
        const result = run(this.database,
          "INSERT INTO projects (project_key, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [parsed.data.projectKey, parsed.data.name, createdAt, createdAt],
        );
        return {
          ok: true,
          data: {
            projectId: toSafeId(result.lastInsertRowid),
            name: parsed.data.name,
            projectKey: parsed.data.projectKey,
            createdAt,
            updatedAt: createdAt,
          },
        };
      });
    } catch (error) {
      if (isProjectKeyUniqueError(error)) {
        return validationFailure("projectKey", "Project key already exists in this Profile database.");
      }
      return sqliteFailure(error);
    }
  }

  createAndBindProject(sessionIdInput: unknown, projectInput: unknown): DomainResult<SessionBindingRecord> {
    const sessionId = validateSessionId(sessionIdInput);
    if (!sessionId.ok) return sessionId;
    const project = parseProjectInput(projectInput);
    if (!project.ok) return parserFailure(project);
    this.assertOpen();
    const createdAt = nowIso();

    try {
      return this.transaction(() => {
        const existing = one<{ projectId: number }>(this.database,
          "SELECT project_id AS projectId FROM session_projects WHERE session_id = ?",
          [sessionId.data],
        );
        if (existing !== undefined) {
          return validationFailure("sessionId", "Session is already bound to a project.");
        }
        const inserted = run(this.database,
          "INSERT INTO projects (project_key, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [project.data.projectKey, project.data.name, createdAt, createdAt],
        );
        const projectId = toSafeId(inserted.lastInsertRowid);
        run(this.database,
          "INSERT INTO session_projects (session_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [sessionId.data, projectId, createdAt, createdAt],
        );
        return {
          ok: true,
          data: {
            sessionId: sessionId.data,
            projectId,
            projectKey: project.data.projectKey,
            name: project.data.name,
            createdAt,
            updatedAt: createdAt,
          },
        };
      });
    } catch (error) {
      if (isProjectKeyUniqueError(error)) {
        return validationFailure("projectKey", "Project key already exists in this Profile database.");
      }
      return sqliteFailure(error);
    }
  }

  getProjectByKey(keyInput: unknown): DomainResult<ProjectRecord | null> {
    const key = parseProjectKey(keyInput);
    if (!key.ok) return parserFailure(key);
    this.assertOpen();
    try {
      const row = one<ProjectRow>(this.database,
        "SELECT id AS projectId, name, project_key AS projectKey, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE project_key = ?",
        [key.data],
      );
      return { ok: true, data: row === undefined ? null : rowToProject(row) };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  listProjects(): DomainResult<ProjectRecord[]> {
    this.assertOpen();
    try {
      const rows = many<ProjectRow>(this.database,
        "SELECT id AS projectId, name, project_key AS projectKey, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY name COLLATE NOCASE, project_key",
      );
      return { ok: true, data: rows.map(rowToProject) };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  bindSession(sessionIdInput: unknown, projectIdInput: unknown): DomainResult<SessionBindingRecord> {
    const sessionId = validateSessionId(sessionIdInput);
    if (!sessionId.ok) return sessionId;
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    this.assertOpen();
    const now = nowIso();
    try {
      return this.transaction(() => {
        const project = one<ProjectRow>(this.database,
          "SELECT id AS projectId, name, project_key AS projectKey, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?",
          [projectId.data],
        );
        if (project === undefined) return failure("PROJECT_REQUIRED", "Project does not exist.");

        const existing = one<{ projectId: number }>(this.database,
          "SELECT project_id AS projectId FROM session_projects WHERE session_id = ?",
          [sessionId.data],
        );
        if (existing !== undefined && existing.projectId !== projectId.data) {
          return validationFailure("sessionId", "Session is already bound to a different project.");
        }
        if (existing === undefined) {
          run(this.database,
            "INSERT INTO session_projects (session_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
            [sessionId.data, projectId.data, now, now],
          );
        }
        return { ok: true, data: { ...rowToProject(project), sessionId: sessionId.data } };
      });
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  getBoundProject(sessionIdInput: unknown): DomainResult<SessionBindingRecord | null> {
    const sessionId = validateSessionId(sessionIdInput);
    if (!sessionId.ok) return sessionId;
    this.assertOpen();
    try {
      const row = one<ProjectRow & { sessionId: string }>(this.database,
        `SELECT p.id AS projectId, p.name, p.project_key AS projectKey,
          p.created_at AS createdAt, p.updated_at AS updatedAt, sp.session_id AS sessionId
        FROM session_projects sp JOIN projects p ON p.id = sp.project_id
        WHERE sp.session_id = ?`,
        [sessionId.data],
      );
      return { ok: true, data: row === undefined ? null : { ...rowToProject(row), sessionId: row.sessionId } };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  createDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionCreateReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionCreateInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();
    try {
      return this.transaction(() => ({ ok: true, data: this.insertDecision(projectId.data, parsed.data) }));
    } catch (error) {
      if (isForeignKeyError(error)) return failure("PROJECT_REQUIRED", "Project is not available in this database.");
      const constraintField = decisionConstraintField(error);
      if (constraintField !== undefined) {
        return validationFailure(constraintField, "Value violates a persisted decision constraint.");
      }
      return sqliteFailure(error);
    }
  }

  createDecisionsBatch(projectIdInput: unknown, input: unknown): DomainResult<DecisionBatchReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionCreateBatchInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();
    try {
      return this.transaction(() => {
        // All rows were parsed before the transaction opened; a rejected row
        // therefore comes from a persisted CHECK, not from input validation.
        const decisions = parsed.data.decisions.map((item, index) => {
          try {
            const receipt = this.insertDecision(projectId.data, item);
            return { index: index + 1, decisionId: receipt.decisionId, revision: 1 as const };
          } catch (error) {
            const constraintField = decisionConstraintField(error);
            if (constraintField === undefined) throw error;
            throw new RowConstraintError(index + 1, constraintField);
          }
        });
        return { ok: true, data: { createdCount: decisions.length, decisions } };
      });
    } catch (error) {
      if (error instanceof RowConstraintError) {
        return failure("VALIDATION_FAILED", "Value violates a persisted decision constraint.", error.field, error.itemIndex);
      }
      if (isForeignKeyError(error)) return failure("PROJECT_REQUIRED", "Project is not available in this database.");
      return sqliteFailure(error);
    }
  }

  getDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionRecord> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionGetInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();
    try {
      const row = one<DecisionRow>(this.database,
        decisionSelect("WHERE id = ? AND project_id = ?"),
        [parsed.data.decisionId, projectId.data],
      );
      if (row === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");
      return { ok: true, data: toDecisionRecord(row) };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  searchDecisions(projectIdInput: unknown, input: unknown): DomainResult<DecisionSearchPage> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionSearchInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();

    const pattern = escapeLikeLiteral(parsed.data.query);
    const statusFilter = parsed.data.includeVoided ? "" : "AND status = 'effective'";
    const sql = `SELECT id AS decisionId, summary, decision_text AS decision, status
      FROM decisions
      WHERE project_id = ? ${statusFilter}
        AND (decision_text LIKE ? ESCAPE '\\'
          OR summary LIKE ? ESCAPE '\\'
          OR rationale LIKE ? ESCAPE '\\'
          OR source_reference LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?`;

    try {
      const rows = many<{ decisionId: number; summary: string | null; decision: string; status: DecisionStatus }>(
        this.database,
        sql,
        [projectId.data, pattern, pattern, pattern, pattern, parsed.data.limit + 1, parsed.data.offset],
      );
      const hasMore = rows.length > parsed.data.limit;
      const selected = hasMore ? rows.slice(0, parsed.data.limit) : rows;
      return {
        ok: true,
        data: {
          decisions: selected.map((row) => ({
            decisionId: row.decisionId,
            preview: previewText(row.summary ?? row.decision),
            status: row.status,
          })),
          hasMore,
        },
      };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  getDecisionHistory(projectIdInput: unknown, decisionIdInput: unknown): DomainResult<DecisionRevisionRecord[]> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const decisionId = parsePositiveSafeInteger(decisionIdInput, "decisionId");
    if (!decisionId.ok) return decisionId;
    this.assertOpen();

    try {
      const decision = one<{ decisionId: number }>(this.database,
        "SELECT id AS decisionId FROM decisions WHERE id = ? AND project_id = ?",
        [decisionId.data, projectId.data],
      );
      if (decision === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");

      const rows = many<RevisionRow>(this.database,
        `SELECT id AS revisionId, decision_id AS decisionId, change_kind AS changeKind,
          snapshot_json AS snapshotJson, created_at AS createdAt
        FROM decision_revisions WHERE decision_id = ? ORDER BY created_at DESC, id DESC`,
        [decisionId.data],
      );
      return {
        ok: true,
        data: rows.map((row) => ({
          revisionId: row.revisionId,
          decisionId: row.decisionId,
          changeKind: row.changeKind,
          snapshot: JSON.parse(row.snapshotJson) as DecisionRecord,
          createdAt: row.createdAt,
        })),
      };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  updateDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionUpdateReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionUpdateInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();

    try {
      return this.transaction(() => {
        const current = this.readDecision(projectId.data, parsed.data.decisionId);
        if (current === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");
        if (current.revision !== parsed.data.expectedRevision) {
          return failure("REVISION_CONFLICT", "Decision changed; read the latest version before deciding whether to retry.");
        }
        if (current.status === "voided") {
          return failure("DECISION_NOT_EDITABLE", "Voided decisions cannot be updated.");
        }

        const changedFields = Object.entries(parsed.data.patch)
          .filter(([field, value]) => current[field as keyof DecisionRow] !== value)
          .map(([field]) => field);
        if (changedFields.length === 0) {
          return {
            ok: true,
            data: {
              decisionId: current.decisionId,
              revision: current.revision,
              changedFields: [],
              status: "effective",
              updatedAt: current.updatedAt,
            },
          };
        }

        const updatedAt = this.nextUpdatedAt(projectId.data);
        this.insertSnapshot(current, "update", updatedAt);
        const columnFor: Record<string, string> = {
          decision: "decision_text",
          summary: "summary",
          rationale: "rationale",
          timeHorizon: "time_horizon",
          decisionDate: "decision_date",
          reviewDate: "review_date",
          sourceReference: "source_reference",
        };
        const setClauses = changedFields.map((field) => `${columnFor[field]} = ?`);
        const values: (string | number | null)[] = changedFields.map((field) => parsed.data.patch[field as keyof typeof parsed.data.patch] ?? null);
        values.push(updatedAt, parsed.data.decisionId, projectId.data, parsed.data.expectedRevision);
        const update = run(this.database,
          `UPDATE decisions SET ${setClauses.join(", ")}, updated_at = ?, revision = revision + 1
           WHERE id = ? AND project_id = ? AND revision = ? AND status = 'effective'`,
          values,
        );
        if (update.changes !== 1 && update.changes !== 1n) {
          throw new Error("Decision update did not affect exactly one row.");
        }
        const updated = this.readDecision(projectId.data, parsed.data.decisionId);
        if (updated === undefined) throw new Error("Updated decision could not be reread.");
        return {
          ok: true,
          data: {
            decisionId: updated.decisionId,
            revision: updated.revision,
            changedFields,
            status: "effective",
            updatedAt: updated.updatedAt,
          },
        };
      });
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  voidDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionVoidReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionVoidInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();

    try {
      return this.transaction(() => {
        const current = this.readDecision(projectId.data, parsed.data.decisionId);
        if (current === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");
        if (current.revision !== parsed.data.expectedRevision) {
          return failure("REVISION_CONFLICT", "Decision changed; read the latest version before deciding whether to retry.");
        }
        if (current.status === "voided") {
          return {
            ok: true,
            data: {
              decisionId: current.decisionId,
              revision: current.revision,
              status: "voided",
              voidedAt: current.voidedAt!,
            },
          };
        }

        const voidedAt = this.nextUpdatedAt(projectId.data);
        this.insertSnapshot(current, "void", voidedAt);
        const update = run(this.database,
          `UPDATE decisions
           SET status = 'voided', void_reason = ?, voided_at = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND project_id = ? AND revision = ? AND status = 'effective'`,
          [parsed.data.reason, voidedAt, voidedAt, parsed.data.decisionId, projectId.data, parsed.data.expectedRevision],
        );
        if (update.changes !== 1 && update.changes !== 1n) {
          throw new Error("Decision void did not affect exactly one row.");
        }
        const updated = this.readDecision(projectId.data, parsed.data.decisionId);
        if (updated === undefined || updated.voidedAt === null) throw new Error("Voided decision could not be reread.");
        return {
          ok: true,
          data: {
            decisionId: updated.decisionId,
            revision: updated.revision,
            status: "voided",
            voidedAt: updated.voidedAt,
          },
        };
      });
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Decision store is closed.");
  }

  private transaction<T>(operation: () => DomainResult<T>): DomainResult<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original transaction error. */ }
      throw error;
    }
  }

  /**
   * Allocate the next `updated_at` for this project, strictly increasing.
   *
   * Why not the wall clock alone: the contract sorts search results by
   * `updatedAt` then `decisionId`, both descending (contract line 114). Two writes
   * inside the same millisecond would share a timestamp and the tie-break would
   * collapse to id order, which is NOT the update order — the sort would silently
   * stop reflecting recency. Ticks are a display value; the ordering guarantee must
   * come from the store.
   *
   * The allocator reads the project's current maximum and returns
   * `max(now, maximum + 1ms)`. Because every decision write inside one project goes
   * through this single statement under `BEGIN IMMEDIATE`, the result is a total
   * order over that project's decisions without a new column, a second sequence
   * table, or a schema migration.
   *
   * Projects are independent: two projects may legitimately share a timestamp,
   * because search never spans projects.
   */
  private nextUpdatedAt(projectId: number): string {
    const maximum = one<{ latest: string | null }>(this.database,
      "SELECT max(updated_at) AS latest FROM decisions WHERE project_id = ?",
      [projectId],
    )?.latest ?? null;
    const latestMillis = maximum === null ? Number.NaN : Date.parse(maximum);
    const nowMillis = Date.now();
    const nextMillis = Number.isFinite(latestMillis) ? Math.max(nowMillis, latestMillis + 1) : nowMillis;
    return new Date(nextMillis).toISOString();
  }

  private insertDecision(projectId: number, input: DecisionCreateInput): DecisionCreateReceipt {
    const createdAt = nowIso();
    // The ordering tick is allocated separately from the display timestamp: a
    // create inside the same millisecond as a previous write must still sort after
    // it (see nextUpdatedAt).
    const updatedAt = this.nextUpdatedAt(projectId);
    const result = run(this.database,
      `INSERT INTO decisions (
        project_id, decision_text, summary, rationale, time_horizon,
        decision_date, review_date, status, void_reason, voided_at,
        source_reference, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'effective', NULL, NULL, ?, ?, ?)`,
      [
        projectId,
        input.decision,
        input.summary ?? null,
        input.rationale ?? null,
        input.timeHorizon,
        input.decisionDate ?? null,
        input.reviewDate ?? null,
        input.sourceReference ?? null,
        createdAt,
        updatedAt,
      ],
    );
    return {
      decisionId: toSafeId(result.lastInsertRowid),
      revision: 1,
      summary: input.summary ?? null,
      status: "effective",
      createdAt,
    };
  }

  private readDecision(projectId: number, decisionId: number): DecisionRow | undefined {
    return one<DecisionRow>(this.database,
      decisionSelect("WHERE id = ? AND project_id = ?"),
      [decisionId, projectId],
    );
  }

  private insertSnapshot(record: DecisionRow, changeKind: "update" | "void", createdAt: string): void {
    const snapshot = toDecisionRecord(record);
    run(this.database,
      `INSERT INTO decision_revisions (decision_id, change_kind, snapshot_json, created_at)
       VALUES (?, ?, ?, ?)`,
      [record.decisionId, changeKind, JSON.stringify(snapshot), createdAt],
    );
  }
}

function isForeignKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

// Frozen contract: errors attributable to one batch row carry a one-based
// itemIndex and the input field; transaction-level errors never fake them.
class RowConstraintError extends Error {
  readonly itemIndex: number;
  readonly field: string;

  constructor(itemIndex: number, field: string) {
    super("A batch row violated a persisted decision constraint.");
    this.itemIndex = itemIndex;
    this.field = field;
  }
}

const DECISION_CONSTRAINT_FIELDS: Record<string, string> = {
  ck_decisions_text: "decision",
  ck_decisions_summary: "summary",
  ck_decisions_rationale_length: "rationale",
  ck_decisions_source_reference_length: "sourceReference",
  ck_decisions_decision_date: "decisionDate",
  ck_decisions_review_date: "reviewDate",
  ck_decisions_time_horizon: "timeHorizon",
};

function decisionConstraintField(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /CHECK constraint failed: (ck_decisions_[a-z_]+)/iu.exec(message);
  if (match === null) return undefined;
  return DECISION_CONSTRAINT_FIELDS[match[1]!.toLowerCase()];
}
