import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";

const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function storeFor(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-ops-"));
  tempRoots.add(root);
  const store = SQLiteDecisionStore.open({ databasePath: join(root, "decisions.sqlite") });
  t.after(() => store.close());
  return store;
}

function dataOf(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function errorOf(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  return result.error;
}

function project(store, name = "Atlas", key = "atlas") {
  return dataOf(store.createProject({ name, projectKey: key }));
}

// Frozen contract §3.2: success bodies are { ok: true, data }, failures are
// { ok: false, error }, and transaction-level errors never carry fake row
// coordinates. These tests pin the wire shape, not only the behaviour.
test("error envelope keys are exactly code/message for non-row errors", (t) => {
  const store = storeFor(t);
  const p = project(store);

  const notFound = store.getDecision(p.projectId, { decisionId: 999 });
  assert.deepEqual(Object.keys(notFound.error).sort(), ["code", "message"]);

  const created = dataOf(store.createDecision(p.projectId, { decision: "original" }));
  dataOf(store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, patch: { decision: "changed" } }));
  const conflict = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, patch: { decision: "stale" } });
  assert.deepEqual(Object.keys(conflict.error).sort(), ["code", "message"]);
  assert.equal(conflict.error.field, undefined);
  assert.equal(conflict.error.itemIndex, undefined);

  const voided = dataOf(store.voidDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 2, reason: "withdrawn" }));
  assert.equal(voided.revision, 3);
  const notEditable = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 3, patch: { decision: "edit voided" } });
  assert.equal(notEditable.error.code, "DECISION_NOT_EDITABLE");
  assert.deepEqual(Object.keys(notEditable.error).sort(), ["code", "message"]);
});

test("validation errors carry field but never itemIndex for single-record calls", (t) => {
  const store = storeFor(t);
  const p = project(store);

  const badSummary = store.createDecision(p.projectId, { decision: "ok", summary: "" });
  errorOf(badSummary, "VALIDATION_FAILED");
  assert.equal(badSummary.error.field, "summary");
  assert.equal(badSummary.error.itemIndex, undefined);

  const unknownField = store.createDecision(p.projectId, { decision: "ok", projectId: 1 });
  errorOf(unknownField, "VALIDATION_FAILED");
  assert.equal(unknownField.error.field, "projectId");

  const nullHorizon = store.createDecision(p.projectId, { decision: "ok", timeHorizon: null });
  errorOf(nullHorizon, "VALIDATION_FAILED");
  assert.equal(nullHorizon.error.field, "timeHorizon");

  const numericDecision = store.createDecision(p.projectId, { decision: 42 });
  errorOf(numericDecision, "VALIDATION_FAILED");
  assert.equal(numericDecision.error.field, "decision");
});

test("batch validation errors report one-based itemIndex plus field", (t) => {
  const store = storeFor(t);
  const p = project(store);

  // Contract §3 batch: 1–100 entries, itemIndex from 1, field identifies the input.
  const tooMany = store.createDecisionsBatch(p.projectId, { decisions: Array.from({ length: 101 }, () => ({ decision: "x" })) });
  errorOf(tooMany, "VALIDATION_FAILED");
  assert.equal(tooMany.error.field, "decisions");

  const empty = store.createDecisionsBatch(p.projectId, { decisions: [] });
  errorOf(empty, "VALIDATION_FAILED");
  assert.equal(empty.error.field, "decisions");

  const secondBad = store.createDecisionsBatch(p.projectId, { decisions: [{ decision: "good" }, { decision: "   " }] });
  errorOf(secondBad, "VALIDATION_FAILED");
  assert.equal(secondBad.error.itemIndex, 2);
  assert.equal(secondBad.error.field, "decision");

  const thirdBadDate = store.createDecisionsBatch(p.projectId, {
    decisions: [{ decision: "a" }, { decision: "b" }, { decision: "c", decisionDate: "2023-02-29" }],
  });
  errorOf(thirdBadDate, "VALIDATION_FAILED");
  assert.equal(thirdBadDate.error.itemIndex, 3);
  assert.equal(thirdBadDate.error.field, "decisionDate");

  // Validation happens before the transaction opens: nothing was written.
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "good" })).decisions.length, 0);

  // Boundary: exactly 100 entries is accepted; 101 is rejected above.
  const hundred = store.createDecisionsBatch(p.projectId, {
    decisions: Array.from({ length: 100 }, (_, index) => ({ decision: `bulk ${index}` })),
  });
  const hundredData = dataOf(hundred);
  assert.equal(hundredData.createdCount, 100);
  assert.equal(hundredData.decisions.length, 100);
  assert.equal(hundredData.decisions[0].index, 1);
  assert.equal(hundredData.decisions[99].index, 100);
});

test("batch rows rejected by persisted constraints keep itemIndex and roll back the whole batch", (t) => {
  const store = storeFor(t);
  const p = project(store);

  // Synthetic injection: the domain parser and the DB CHECK now share one
  // length口径 (T1.1), so a persisted-constraint rejection is forced through a
  // TEMP trigger that raises the real constraint name. This pins the mapper,
  // not a real input path.
  store.database.exec(`CREATE TEMP TRIGGER fail_batch_row
    BEFORE INSERT ON decisions WHEN NEW.decision_text = 'persisted-reject'
    BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: ck_decisions_text'); END`);

  const rejected = store.createDecisionsBatch(p.projectId, {
    decisions: [{ decision: "keep me" }, { decision: "persisted-reject" }, { decision: "also keep me" }],
  });
  errorOf(rejected, "VALIDATION_FAILED");
  assert.equal(rejected.error.itemIndex, 2);
  assert.equal(rejected.error.field, "decision");
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "keep" })).decisions.length, 0);
});

test("single-record persisted constraint rejection maps to VALIDATION_FAILED with field", (t) => {
  const store = storeFor(t);
  const p = project(store);
  store.database.exec(`CREATE TEMP TRIGGER fail_single_row
    BEFORE INSERT ON decisions WHEN NEW.summary = 'summary-reject'
    BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: ck_decisions_summary'); END`);

  const rejected = store.createDecision(p.projectId, { decision: "ok", summary: "summary-reject" });
  errorOf(rejected, "VALIDATION_FAILED");
  assert.equal(rejected.error.field, "summary");
  assert.equal(rejected.error.itemIndex, undefined);
});

test("transaction-level failures never fabricate itemIndex or field", (t) => {
  const store = storeFor(t);
  const p = project(store);
  store.database.exec(`CREATE TEMP TRIGGER fail_batch_tx
    BEFORE INSERT ON decisions WHEN NEW.decision_text = 'tx-fail'
    BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END`);

  const failed = store.createDecisionsBatch(p.projectId, { decisions: [{ decision: "first" }, { decision: "tx-fail" }] });
  errorOf(failed, "DATABASE_ERROR");
  assert.equal(failed.error.field, undefined);
  assert.equal(failed.error.itemIndex, undefined);

  const failedSingle = store.createDecision(p.projectId, { decision: "tx-fail" });
  errorOf(failedSingle, "DATABASE_ERROR");
  assert.equal(failedSingle.error.field, undefined);
});

test("unknown project yields PROJECT_REQUIRED at transaction level without row coordinates", (t) => {
  const store = storeFor(t);
  const failed = store.createDecision(999, { decision: "orphan" });
  errorOf(failed, "PROJECT_REQUIRED");
  assert.equal(failed.error.field, undefined);
  assert.equal(failed.error.itemIndex, undefined);

  const failedBatch = store.createDecisionsBatch(999, { decisions: [{ decision: "orphan one" }, { decision: "orphan two" }] });
  errorOf(failedBatch, "PROJECT_REQUIRED");
  assert.equal(failedBatch.error.itemIndex, undefined);
});

test("search matching is ASCII case-insensitive and literal for % and _", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "Use SQLite For Storage" }));
  dataOf(store.createDecision(p.projectId, { decision: "literal 50%_off marker" }));
  dataOf(store.createDecision(p.projectId, { decision: "Café Ünïcode" }));

  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "sqlite" })).decisions.length, 1);
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "SQLITE" })).decisions.length, 1);
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "50%_off" })).decisions.length, 1);
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "50_off" })).decisions.length, 0);
  // Contract §3 search: ASCII letters are case-insensitive, non-ASCII is
  // matched by original code point only ("CAFÉ" does not match "Café").
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "café" })).decisions.length, 1);
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "CAFÉ" })).decisions.length, 0);
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "ünïcode" })).decisions.length, 0);
  assert.equal(dataOf(store.searchDecisions(p.projectId, { query: "Ünïcode" })).decisions.length, 1);
});

test("search sorts by updatedAt then decisionId, both descending", (t) => {
  const store = storeFor(t);
  const p = project(store);
  for (let index = 0; index < 3; index += 1) dataOf(store.createDecision(p.projectId, { decision: `ordered ${index}` }));
  dataOf(store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 1, patch: { decision: "ordered 0 revised" } }));

  const hits = dataOf(store.searchDecisions(p.projectId, { query: "ordered" })).decisions;
  assert.deepEqual(hits.map((hit) => hit.decisionId), [1, 3, 2]);
});

test("error messages never echo decision text, rationale, or source text", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const secret = "sensitive-body-marker";
  dataOf(store.createDecision(p.projectId, { decision: secret, rationale: "secret-rationale-marker", sourceReference: "secret-source-marker" }));
  dataOf(store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 1, patch: { decision: "changed" } }));

  const conflict = store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 1, patch: { decision: secret } });
  const notFound = store.getDecision(p.projectId, { decisionId: 999 });
  const validation = store.createDecision(p.projectId, { decision: "  " });
  for (const result of [conflict, notFound, validation]) {
    const serialized = JSON.stringify(result);
    for (const marker of [secret, "secret-rationale-marker", "secret-source-marker"]) {
      assert.equal(serialized.includes(marker), false, `error leaked ${marker}: ${serialized}`);
    }
  }
});

test("search pagination reports hasMore from one extra probe row", (t) => {
  const store = storeFor(t);
  const p = project(store);
  for (let index = 0; index < 3; index += 1) dataOf(store.createDecision(p.projectId, { decision: `paged ${index}` }));

  const page = dataOf(store.searchDecisions(p.projectId, { query: "paged", limit: 2, offset: 0 }));
  assert.equal(page.decisions.length, 2);
  assert.equal(page.hasMore, true);
  const last = dataOf(store.searchDecisions(p.projectId, { query: "paged", limit: 2, offset: 2 }));
  assert.equal(last.decisions.length, 1);
  assert.equal(last.hasMore, false);
  const beyond = dataOf(store.searchDecisions(p.projectId, { query: "paged", limit: 2, offset: 10 }));
  assert.equal(beyond.decisions.length, 0);
  assert.equal(beyond.hasMore, false);
});

test("update null clears optional fields and rejects empty strings", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, {
    decision: "keep decision text",
    summary: "initial summary",
    rationale: "initial rationale",
    sourceReference: "initial source",
    reviewDate: "2026-12-01",
  }));

  const cleared = store.updateDecision(p.projectId, {
    decisionId: 1,
    expectedRevision: 1,
    patch: { summary: null, rationale: null, sourceReference: null, reviewDate: null },
  });
  const clearedData = dataOf(cleared);
  assert.equal(clearedData.revision, 2);
  assert.deepEqual([...clearedData.changedFields].sort(), ["rationale", "reviewDate", "sourceReference", "summary"]);
  const reread = dataOf(store.getDecision(p.projectId, { decisionId: 1 }));
  assert.equal(reread.summary, null);
  assert.equal(reread.rationale, null);
  assert.equal(reread.sourceReference, null);
  assert.equal(reread.reviewDate, null);
  assert.equal(reread.decision, "keep decision text");

  const emptyString = store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 2, patch: { summary: "" } });
  errorOf(emptyString, "VALIDATION_FAILED");
  assert.equal(emptyString.error.field, "summary");

  const nullDecision = store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 2, patch: { decision: null } });
  errorOf(nullDecision, "VALIDATION_FAILED");
  assert.equal(nullDecision.error.field, "patch.decision");

  // Contract §3 update: decision/timeHorizon reject null; cleared fields are
  // exactly the optional ones.
  const nullHorizon = store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 2, patch: { timeHorizon: null } });
  errorOf(nullHorizon, "VALIDATION_FAILED");
  assert.equal(nullHorizon.error.field, "patch.timeHorizon");

  const emptyPatch = store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 2, patch: {} });
  errorOf(emptyPatch, "VALIDATION_FAILED");
  assert.equal(emptyPatch.error.field, "patch");

  const unknownPatchField = store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 2, patch: { projectId: 2 } });
  errorOf(unknownPatchField, "VALIDATION_FAILED");
  assert.equal(unknownPatchField.error.field, "patch.projectId");
});

test("no-op update and repeated void add no snapshot and keep revision", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "same text", summary: "same summary" }));

  const beforeHistory = dataOf(store.getDecisionHistory(p.projectId, 1));
  assert.equal(beforeHistory.length, 0);
  const noOp = dataOf(store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 1, patch: { summary: "same summary" } }));
  assert.equal(noOp.revision, 1);
  assert.deepEqual(noOp.changedFields, []);
  assert.equal(dataOf(store.getDecisionHistory(p.projectId, 1)).length, 0);

  const firstVoid = dataOf(store.voidDecision(p.projectId, { decisionId: 1, expectedRevision: 1, reason: "reason one" }));
  assert.equal(firstVoid.revision, 2);
  const afterFirstVoid = dataOf(store.getDecisionHistory(p.projectId, 1));
  assert.equal(afterFirstVoid.length, 1);

  const repeatedVoid = dataOf(store.voidDecision(p.projectId, { decisionId: 1, expectedRevision: 2, reason: "reason two" }));
  assert.equal(repeatedVoid.revision, 2);
  assert.equal(repeatedVoid.voidedAt, firstVoid.voidedAt);
  assert.equal(dataOf(store.getDecisionHistory(p.projectId, 1)).length, 1);
  const reread = dataOf(store.getDecision(p.projectId, { decisionId: 1 }));
  assert.equal(reread.voidReason, "reason one");
});

test("history returns snapshots newest first with the pre-change revision", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "v1" }));
  dataOf(store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 1, patch: { decision: "v2" } }));
  dataOf(store.updateDecision(p.projectId, { decisionId: 1, expectedRevision: 2, patch: { decision: "v3" } }));
  dataOf(store.voidDecision(p.projectId, { decisionId: 1, expectedRevision: 3, reason: "done" }));

  const history = dataOf(store.getDecisionHistory(p.projectId, 1));
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((entry) => entry.snapshot.revision), [3, 2, 1]);
  assert.deepEqual(history.map((entry) => entry.changeKind), ["void", "update", "update"]);
  assert.equal(history[0].snapshot.status, "effective");
  assert.equal(history[0].snapshot.decision, "v3");
  assert.equal(history[2].snapshot.decision, "v1");
});
