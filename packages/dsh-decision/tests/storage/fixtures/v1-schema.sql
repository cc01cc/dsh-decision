-- task-377 migration fixture: the exact schema a v1 (pre-task-377) store
-- created, dumped from sqlite_master after opening a database with the HEAD
-- version of src/storage/sqlite-store.ts. Do not hand-edit; regenerate from the
-- v1 module if the historical schema ever needs re-verification.
CREATE TABLE decision_revisions (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL,
  change_kind TEXT NOT NULL CONSTRAINT ck_decision_revisions_change_kind
    CHECK (change_kind IN ('update', 'void')),
  snapshot_json TEXT NOT NULL CONSTRAINT ck_decision_revisions_snapshot_json
    CHECK (length(snapshot_json) > 0 AND instr(CAST(snapshot_json AS BLOB), X'00') = 0),
  created_at TEXT NOT NULL,
  CONSTRAINT fk_decision_revisions_decision_id
    FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE RESTRICT
)STRICT;

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_decisions_revision CHECK (revision > 0),
  project_id INTEGER NOT NULL,
  decision_text TEXT NOT NULL CONSTRAINT ck_decisions_text CHECK (
    length(decision_text) BETWEEN 1 AND 20000
    AND length(trim(decision_text, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) > 0
    AND instr(CAST(decision_text AS BLOB), X'00') = 0
  ),
  summary TEXT CONSTRAINT ck_decisions_summary CHECK ((summary IS NULL OR (
    length(summary) BETWEEN 1 AND 300
    AND length(trim(summary, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) > 0
    AND instr(CAST(summary AS BLOB), X'00') = 0
  ))),
  rationale TEXT CONSTRAINT ck_decisions_rationale_length CHECK ((rationale IS NULL OR (
    length(rationale) BETWEEN 1 AND 20000
    AND length(trim(rationale, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) > 0
    AND instr(CAST(rationale AS BLOB), X'00') = 0
  ))),
  time_horizon TEXT NOT NULL DEFAULT 'temporary'
    CONSTRAINT ck_decisions_time_horizon CHECK (time_horizon IN ('long_term', 'temporary')),
  decision_date TEXT CONSTRAINT ck_decisions_decision_date CHECK ((decision_date IS NULL OR (
    length(decision_date) = 10
    AND decision_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(decision_date, 1, 4) <> '0000'
    AND strftime('%Y-%m-%d', decision_date, '+0 days') IS NOT NULL
    AND strftime('%Y-%m-%d', decision_date, '+0 days') = decision_date
  ))),
  review_date TEXT CONSTRAINT ck_decisions_review_date CHECK ((review_date IS NULL OR (
    length(review_date) = 10
    AND review_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(review_date, 1, 4) <> '0000'
    AND strftime('%Y-%m-%d', review_date, '+0 days') IS NOT NULL
    AND strftime('%Y-%m-%d', review_date, '+0 days') = review_date
  ))),
  status TEXT NOT NULL DEFAULT 'effective'
    CONSTRAINT ck_decisions_status CHECK (status IN ('effective', 'voided')),
  void_reason TEXT,
  voided_at TEXT,
  source_reference TEXT CONSTRAINT ck_decisions_source_reference_length CHECK ((source_reference IS NULL OR (
    length(source_reference) BETWEEN 1 AND 4000
    AND length(trim(source_reference, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) > 0
    AND instr(CAST(source_reference AS BLOB), X'00') = 0
  ))),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT ck_decisions_void_state CHECK (
    (status = 'effective' AND void_reason IS NULL AND voided_at IS NULL)
    OR
    (status = 'voided' AND void_reason IS NOT NULL
      AND length(void_reason) BETWEEN 1 AND 1000
      AND length(trim(void_reason, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) > 0
      AND instr(CAST(void_reason AS BLOB), X'00') = 0
      AND voided_at IS NOT NULL)
  ),
  CONSTRAINT fk_decisions_project_id
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
)STRICT;

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
    length(trim(name, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) BETWEEN 1 AND 64
    AND name = trim(name, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))
    AND instr(CAST(name AS BLOB), X'00') = 0
    AND instr(name, char(1)) = 0 AND instr(name, char(2)) = 0 AND instr(name, char(3)) = 0 AND instr(name, char(4)) = 0 AND instr(name, char(5)) = 0 AND instr(name, char(6)) = 0 AND instr(name, char(7)) = 0 AND instr(name, char(8)) = 0 AND instr(name, char(9)) = 0 AND instr(name, char(10)) = 0 AND instr(name, char(11)) = 0 AND instr(name, char(12)) = 0 AND instr(name, char(13)) = 0 AND instr(name, char(14)) = 0 AND instr(name, char(15)) = 0 AND instr(name, char(16)) = 0 AND instr(name, char(17)) = 0 AND instr(name, char(18)) = 0 AND instr(name, char(19)) = 0 AND instr(name, char(20)) = 0 AND instr(name, char(21)) = 0 AND instr(name, char(22)) = 0 AND instr(name, char(23)) = 0 AND instr(name, char(24)) = 0 AND instr(name, char(25)) = 0 AND instr(name, char(26)) = 0 AND instr(name, char(27)) = 0 AND instr(name, char(28)) = 0 AND instr(name, char(29)) = 0 AND instr(name, char(30)) = 0 AND instr(name, char(31)) = 0 AND instr(name, char(127)) = 0 AND instr(name, char(128)) = 0 AND instr(name, char(129)) = 0 AND instr(name, char(130)) = 0 AND instr(name, char(131)) = 0 AND instr(name, char(132)) = 0 AND instr(name, char(133)) = 0 AND instr(name, char(134)) = 0 AND instr(name, char(135)) = 0 AND instr(name, char(136)) = 0 AND instr(name, char(137)) = 0 AND instr(name, char(138)) = 0 AND instr(name, char(139)) = 0 AND instr(name, char(140)) = 0 AND instr(name, char(141)) = 0 AND instr(name, char(142)) = 0 AND instr(name, char(143)) = 0 AND instr(name, char(144)) = 0 AND instr(name, char(145)) = 0 AND instr(name, char(146)) = 0 AND instr(name, char(147)) = 0 AND instr(name, char(148)) = 0 AND instr(name, char(149)) = 0 AND instr(name, char(150)) = 0 AND instr(name, char(151)) = 0 AND instr(name, char(152)) = 0 AND instr(name, char(153)) = 0 AND instr(name, char(154)) = 0 AND instr(name, char(155)) = 0 AND instr(name, char(156)) = 0 AND instr(name, char(157)) = 0 AND instr(name, char(158)) = 0 AND instr(name, char(159)) = 0
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)STRICT;

CREATE TABLE session_projects (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL CONSTRAINT ck_session_projects_session_id
    CHECK (length(session_id) > 0 AND instr(CAST(session_id AS BLOB), X'00') = 0),
  project_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT fk_session_projects_project_id
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
)STRICT;

CREATE INDEX idx_decision_revisions_decision_created
  ON decision_revisions(decision_id, created_at DESC, id DESC);

CREATE INDEX idx_decisions_project_updated ON decisions(project_id, updated_at DESC, id DESC);

CREATE INDEX idx_projects_name ON projects(name);

CREATE INDEX idx_session_projects_project_id ON session_projects(project_id);

CREATE UNIQUE INDEX uq_projects_project_key ON projects(project_key);

CREATE UNIQUE INDEX uq_session_projects_session_id ON session_projects(session_id);