import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";
import { parseDecisionSearchInput } from "../../src/domain/decision-contract.ts";

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

// ---------------------------------------------------------------------------
// task-377 ①: external_id idempotency key (requirements §10.2). The only one of
// the four current requirements whose absence permanently produces dirty data:
// this store has no physical delete, so a duplicate row can never be removed.
// ---------------------------------------------------------------------------

test("create with externalId echoes the key and dedupes a repeated create", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const first = dataOf(store.createDecision(p.projectId, { decision: "original ruling", externalId: "D-1120" }));
  assert.equal(first.externalId, "D-1120");
  assert.equal(first.alreadyExisted, false);
  assert.equal(first.revision, 1);
  assert.equal(first.status, "effective");

  // Same key, DIFFERENT content: the existing record is returned, not a second row.
  const repeat = dataOf(store.createDecision(p.projectId, { decision: "totally different text", externalId: "D-1120" }));
  assert.equal(repeat.decisionId, first.decisionId);
  assert.equal(repeat.alreadyExisted, true);
  assert.equal(repeat.externalId, "D-1120");
  assert.equal(repeat.createdAt, first.createdAt);
  const current = dataOf(store.getDecision(p.projectId, { decisionId: first.decisionId }));
  assert.equal(current.decision, "original ruling", "the original content is untouched");
  assert.equal(current.externalId, "D-1120");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 1);
});

test("dedupe returns the existing record's current revision and status", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const first = dataOf(store.createDecision(p.projectId, { decision: "v1", externalId: "D-1" }));
  dataOf(store.updateDecision(p.projectId, { decisionId: first.decisionId, expectedRevision: 1, patch: { decision: "v2" } }));
  const afterUpdate = dataOf(store.createDecision(p.projectId, { decision: "dup", externalId: "D-1" }));
  assert.equal(afterUpdate.decisionId, first.decisionId);
  assert.equal(afterUpdate.revision, 2, "the caller must receive the revision to pass as expectedRevision");
  assert.equal(afterUpdate.status, "effective");

  dataOf(store.voidDecision(p.projectId, { decisionId: first.decisionId, expectedRevision: 2, reason: "withdrawn" }));
  const afterVoid = dataOf(store.createDecision(p.projectId, { decision: "dup", externalId: "D-1" }));
  assert.equal(afterVoid.decisionId, first.decisionId);
  assert.equal(afterVoid.status, "voided");
  assert.equal(afterVoid.revision, 3);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 1);
});

test("external_id uniqueness spans projects inside one Profile database", (t) => {
  const store = storeFor(t);
  const a = project(store, "Atlas", "atlas");
  const b = project(store, "Borealis", "borealis");
  const first = dataOf(store.createDecision(a.projectId, { decision: "in atlas", externalId: "D-77" }));
  const other = dataOf(store.createDecision(b.projectId, { decision: "in borealis", externalId: "D-77" }));
  assert.equal(other.decisionId, first.decisionId, "the ledger key identifies one record Profile-wide");
  assert.equal(other.alreadyExisted, true);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 1);
  // task-600 ③: the cross-project hit must SAY it belongs elsewhere — otherwise
  // project B gets an id it cannot read and reads the receipt as a success.
  assert.equal(other.existingProjectId, a.projectId, "cross-project hit names the owning project");
  assert.equal(
    store.getDecision(b.projectId, { decisionId: other.decisionId }).error.code,
    "DECISION_NOT_FOUND",
    "and that id really is unreadable from B",
  );
  // Same-project dedupe stays a plain dedupe: no ownership field at all.
  const sameAgain = dataOf(store.createDecision(a.projectId, { decision: "in atlas again", externalId: "D-77" }));
  assert.equal(sameAgain.decisionId, first.decisionId);
  assert.equal(sameAgain.alreadyExisted, true);
  assert.equal(other.existingProjectId !== undefined && sameAgain.existingProjectId === undefined, true);
  assert.equal("existingProjectId" in sameAgain, false, "same-project receipt keeps its original shape");
  // Batch path carries the same marker.
  const c = project(store, "Cetus", "cetus");
  const batch = dataOf(store.createDecisionsBatch(c.projectId, { decisions: [
    { decision: "mine", externalId: "C-1" },
    { decision: "theirs", externalId: "D-77" },
  ] }));
  assert.equal(batch.createdCount, 1);
  assert.equal(batch.decisions[0].existingProjectId, undefined);
  assert.equal(batch.decisions[1].existingProjectId, a.projectId);
});

test("create without externalId keeps exactly the frozen receipt shape", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const receipt = dataOf(store.createDecision(p.projectId, { decision: "plain" }));
  assert.deepEqual(Object.keys(receipt).sort(), ["createdAt", "decisionId", "revision", "status", "summary"]);
  const got = dataOf(store.getDecision(p.projectId, { decisionId: receipt.decisionId }));
  assert.equal(got.externalId, null);
  assert.equal(got.replaces, null);
});

test("invalid externalId values are rejected with field externalId and write nothing", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const badValues = ["", "   ", "\u0000", "x".repeat(201), 42, null, {}, ["D-1"]];
  for (const value of badValues) {
    const result = store.createDecision(p.projectId, { decision: "ok", externalId: value });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "externalId", JSON.stringify(value));
    assert.equal(result.error.itemIndex, undefined);
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
  // 200 code points is the accepted upper bound (counted in code points).
  const ok = dataOf(store.createDecision(p.projectId, { decision: "ok", externalId: "🐉".repeat(200) }));
  assert.equal(ok.externalId, "🐉".repeat(200));
});

test("task-600 ①: an externalId with leading/trailing whitespace is rejected, never trimmed", (t) => {
  const store = storeFor(t);
  const p = project(store);
  // 五写法各一次：前空格 / 后空格 / 前后都有 / 制表符 / 全角空格(U+3000)。
  const padded = [" D-1120", "D-1120 ", " D-1120 ", "\tD-1120", "D-1120\u3000"];
  for (const value of padded) {
    const result = store.createDecision(p.projectId, { decision: "ok", externalId: value });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "externalId", JSON.stringify(value));
    assert.match(result.error.message, /whitespace/i, JSON.stringify(value));
  }
  // 批内同样拒绝，且整批回滚（不留半条）。
  const batch = store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "fine", externalId: "D-1120" },
    { decision: "padded", externalId: "D-1120 " },
  ] });
  errorOf(batch, "VALIDATION_FAILED");
  assert.equal(batch.error.field, "externalId");
  assert.equal(batch.error.itemIndex, 2);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0, "nothing was written");

  // 无空白键照常通过；「看起来像」的不同写法仍是不同键（不折叠大小写/不补零）。
  assert.equal(dataOf(store.createDecision(p.projectId, { decision: "clean", externalId: "D-1120" })).externalId, "D-1120");
  for (const shape of ["d-1120", "D-01120"]) {
    const receipt = dataOf(store.createDecision(p.projectId, { decision: "distinct " + shape, externalId: shape }));
    assert.equal(receipt.alreadyExisted, false, shape + " must stay a distinct key (no folding, no zero padding)");
  }
});

test("batch dedupes within one batch and across batches after an interrupted run", (t) => {
  const store = storeFor(t);
  const p = project(store);

  // Within-batch: the third row repeats the first row's key.
  const mixed = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "x", externalId: "D-10" },
    { decision: "y", externalId: "D-11" },
    { decision: "x again", externalId: "D-10" },
  ] }));
  assert.equal(mixed.createdCount, 2, "deduplicated rows are not counted as created");
  assert.equal(mixed.decisions.length, 3, "one entry per submitted row");
  assert.equal(mixed.decisions[2].alreadyExisted, true);
  assert.equal(mixed.decisions[2].decisionId, mixed.decisions[0].decisionId);
  assert.equal(mixed.decisions[2].revision, 1);
  assert.equal(mixed.decisions[1].alreadyExisted, false);

  // Across batches: a batch interrupted mid-run (row 3 fails a persisted CHECK
  // via an injected trigger) rolls back; re-submitting the same keys must not
  // duplicate the rows that an earlier successful batch already committed.
  const committed = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "a", externalId: "D-20" },
    { decision: "b", externalId: "D-21" },
  ] }));
  assert.equal(committed.createdCount, 2);
  store.database.exec(`
    CREATE TEMP TRIGGER fail_third BEFORE INSERT ON decisions
    WHEN NEW.decision_text = 'boom'
    BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: ck_decisions_text'); END;
  `);
  const interrupted = store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "c", externalId: "D-22" },
    { decision: "boom", externalId: "D-23" },
  ] });
  errorOf(interrupted, "VALIDATION_FAILED");
  store.database.exec("DROP TRIGGER fail_third");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 4, "the failed batch left nothing behind");

  // Re-run BOTH batches exactly as submitted: nothing new may be created.
  const rerun1 = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "a", externalId: "D-20" },
    { decision: "b", externalId: "D-21" },
  ] }));
  assert.equal(rerun1.createdCount, 0);
  assert.deepEqual(rerun1.decisions.map((d) => d.decisionId), committed.decisions.map((d) => d.decisionId));
  assert.ok(rerun1.decisions.every((d) => d.alreadyExisted === true));
  const rerun2 = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "c", externalId: "D-22" },
    { decision: "c fixed", externalId: "D-23" },
  ] }));
  assert.equal(rerun2.createdCount, 2, "the interrupted batch's keys were never committed");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 6);
});

test("848-row migration in 9 batches is idempotent on a full re-run", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const rows = Array.from({ length: 848 }, (_, i) => ({
    decision: "migrated decision " + i,
    externalId: "D-" + (90000 + i),
  }));
  const batches = [];
  for (let start = 0; start < rows.length; start += 100) batches.push(rows.slice(start, start + 100));
  assert.equal(batches.length, 9, "848 rows at <=100 per batch is 9 batches");

  const firstIds = [];
  for (const batch of batches) {
    const receipt = dataOf(store.createDecisionsBatch(p.projectId, { decisions: batch }));
    assert.equal(receipt.createdCount, batch.length);
    firstIds.push(...receipt.decisions.map((d) => d.decisionId));
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 848);

  // The whole migration re-runs (the real failure mode: the runner died between
  // batches and nobody knows which batches landed). Every row dedupes.
  const againIds = [];
  for (const batch of batches) {
    const receipt = dataOf(store.createDecisionsBatch(p.projectId, { decisions: batch }));
    assert.equal(receipt.createdCount, 0, "a re-run batch creates nothing");
    assert.ok(receipt.decisions.every((d) => d.alreadyExisted === true));
    againIds.push(...receipt.decisions.map((d) => d.decisionId));
  }
  assert.deepEqual(againIds, firstIds, "re-run resolves to exactly the same DSD numbers");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 848);
});

test("batch rows without externalId keep the frozen entry shape and are not deduplicated", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const receipt = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [{ decision: "a" }, { decision: "b" }] }));
  assert.equal(receipt.createdCount, 2);
  for (const entry of receipt.decisions) {
    assert.deepEqual(Object.keys(entry).sort(), ["decisionId", "index", "revision"]);
    assert.equal(entry.revision, 1);
  }
  const again = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [{ decision: "a" }, { decision: "b" }] }));
  assert.equal(again.createdCount, 2, "without a key a repeated batch duplicates, exactly as before");
});

test("batch extension validation reports itemIndex and rolls the whole batch back", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const badKey = store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "ok", externalId: "D-30" },
    { decision: "ok", externalId: "" },
  ] });
  errorOf(badKey, "VALIDATION_FAILED");
  assert.equal(badKey.error.field, "externalId");
  assert.equal(badKey.error.itemIndex, 2);
  const badRefs = store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "ok", refs: [{ type: "bl", id: "BL-584" }] },
  ] });
  errorOf(badRefs, "VALIDATION_FAILED");
  assert.equal(badRefs.error.field, "refs");
  assert.equal(badRefs.error.itemIndex, 1);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, 0);
});

// ---------------------------------------------------------------------------
// task-377 ②: refs direction rule (requirements §10.3). A decision may reference
// plan/task/commit/decision, never bl; the reversed edge is rejected at write
// time, and the reverse index exists for the requirement's own queries.
// ---------------------------------------------------------------------------

test("create stores the four allowed ref types and the reverse index answers refs-of", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, {
    decision: "with references",
    refs: [
      { type: "decision", id: "D-1119" },
      { type: "task", id: "T-194" },
      { type: "plan", id: "PLAN-0769" },
      { type: "commit", id: "a1b2c3d" },
    ],
  }));
  const edges = store.database.prepare("SELECT ref_type, ref_key FROM decision_refs WHERE decision_id = ? ORDER BY id").all(created.decisionId)
    .map((row) => ({ ref_type: row.ref_type, ref_key: row.ref_key }));
  assert.deepEqual(edges, [
    { ref_type: "decision", ref_key: "D-1119" },
    { ref_type: "task", ref_key: "T-194" },
    { ref_type: "plan", ref_key: "PLAN-0769" },
    { ref_type: "commit", ref_key: "a1b2c3d" },
  ]);
  // The requirement consumes the reverse index directly (no query API needed):
  // "which decisions reference this key" and "does this decision have a task ref".
  const reverse = store.database.prepare("SELECT decision_id FROM decision_refs WHERE ref_type = ? AND ref_key = ?").all("task", "T-194")
    .map((row) => ({ decision_id: row.decision_id }));
  assert.deepEqual(reverse, [{ decision_id: created.decisionId }]);
  const hasTask = store.database.prepare("SELECT 1 AS x FROM decision_refs WHERE decision_id = ? AND ref_type = 'task' LIMIT 1").get(created.decisionId);
  assert.equal(hasTask.x, 1);
  // A decision without refs answers "no downstream task".
  const bare = dataOf(store.createDecision(p.projectId, { decision: "no refs" }));
  const noTask = store.database.prepare("SELECT 1 AS x FROM decision_refs WHERE decision_id = ? AND ref_type = 'task' LIMIT 1").get(bare.decisionId);
  assert.equal(noTask, undefined);
});

test("a decision referencing bl is rejected: the reversed direction never lands", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const reversed = store.createDecision(p.projectId, {
    decision: "wrong direction",
    refs: [{ type: "bl", id: "BL-584" }],
  });
  errorOf(reversed, "VALIDATION_FAILED");
  assert.equal(reversed.error.field, "refs");
  assert.match(reversed.error.message, /direction rule/i);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, 0);
  // Mixed list: one reversed edge poisons the whole create.
  const mixed = store.createDecision(p.projectId, {
    decision: "mixed",
    refs: [{ type: "task", id: "T-1" }, { type: "bl", id: "BL-2" }],
  });
  errorOf(mixed, "VALIDATION_FAILED");
  assert.equal(mixed.error.field, "refs");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, 0);
});

test("the direction rule is structural: direct SQL cannot insert a bl edge either", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, { decision: "host" }));
  assert.throws(
    () => store.database.prepare("INSERT INTO decision_refs (decision_id, ref_type, ref_key, created_at) VALUES (?, 'bl', 'BL-584', '2026-11-14T00:00:00.000Z')").run(created.decisionId),
    /CHECK constraint failed: ck_decision_refs_type/i,
  );
});

test("invalid refs shapes are rejected with field refs", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const badLists = [
    null,
    "T-194",
    {},
    [null],
    ["T-194"],
    [{ type: "task" }],
    [{ id: "T-194" }],
    [{ type: "task", id: "T-194", extra: 1 }],
    [{ type: "issue", id: "T-194" }],
    [{ type: 42, id: "T-194" }],
    [{ type: "task", id: "" }],
    [{ type: "task", id: "   " }],
    [{ type: "task", id: "a\u0000b" }],
    [{ type: "task", id: "x".repeat(201) }],
    [{ type: "task", id: 194 }],
    [{ type: "task", id: "T-1" }, { type: "task", id: "T-1" }],
  ];
  for (const refs of badLists) {
    const result = store.createDecision(p.projectId, { decision: "ok", refs });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "refs", JSON.stringify(refs));
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
  // An empty list is allowed and stores no edges.
  const empty = dataOf(store.createDecision(p.projectId, { decision: "ok", refs: [] }));
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs WHERE decision_id = ?").get(empty.decisionId).n, 0);
});

test("refs commit atomically with the decision inside a batch", (t) => {
  const store = storeFor(t);
  const p = project(store);
  store.database.exec(`
    CREATE TEMP TRIGGER fail_second BEFORE INSERT ON decisions
    WHEN NEW.decision_text = 'boom'
    BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: ck_decisions_text'); END;
  `);
  const result = store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "with refs", refs: [{ type: "task", id: "T-1" }] },
    { decision: "boom" },
  ] });
  errorOf(result, "VALIDATION_FAILED");
  store.database.exec("DROP TRIGGER fail_second");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, 0, "no orphan edges survive the rollback");
});

// ---------------------------------------------------------------------------
// task-377 ④: time_scope default long_term + replaces (requirements §10.4/§10.5).
// ---------------------------------------------------------------------------

test("omitting timeHorizon defaults to long_term; an explicit value still wins", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const defaulted = dataOf(store.createDecision(p.projectId, { decision: "defaulted" }));
  assert.equal(dataOf(store.getDecision(p.projectId, { decisionId: defaulted.decisionId })).timeHorizon, "long_term");
  const explicit = dataOf(store.createDecision(p.projectId, { decision: "explicit", timeHorizon: "temporary" }));
  assert.equal(dataOf(store.getDecision(p.projectId, { decisionId: explicit.decisionId })).timeHorizon, "temporary");
  const batch = dataOf(store.createDecisionsBatch(p.projectId, { decisions: [
    { decision: "batch default" },
    { decision: "batch explicit", timeHorizon: "temporary" },
  ] }));
  const horizons = batch.decisions.map((d) => dataOf(store.getDecision(p.projectId, { decisionId: d.decisionId })).timeHorizon);
  assert.deepEqual(horizons, ["long_term", "temporary"]);
  // An explicit null is still rejected by the frozen parser (no coercion).
  const nullHorizon = store.createDecision(p.projectId, { decision: "ok", timeHorizon: null });
  errorOf(nullHorizon, "VALIDATION_FAILED");
  assert.equal(nullHorizon.error.field, "timeHorizon");
});

test("replaces is written on the new record only; the old records are never modified", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const old1 = dataOf(store.createDecision(p.projectId, { decision: "old ruling one" }));
  const old2 = dataOf(store.createDecision(p.projectId, { decision: "old ruling two" }));
  const newer = dataOf(store.createDecision(p.projectId, { decision: "new ruling", replaces: [old1.decisionId, old2.decisionId] }));
  const got = dataOf(store.getDecision(p.projectId, { decisionId: newer.decisionId }));
  assert.deepEqual(got.replaces, [old1.decisionId, old2.decisionId]);
  for (const old of [old1, old2]) {
    const current = dataOf(store.getDecision(p.projectId, { decisionId: old.decisionId }));
    assert.equal(current.revision, 1, "the replaced record keeps its revision");
    assert.equal(current.status, "effective", "the replaced record is not auto-voided");
    assert.equal(current.replaces, null);
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_revisions").get().n, 0, "no snapshot is written on the old records");
});

test("invalid replaces values are rejected with field replaces", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const badValues = [null, "1", {}, [], [0], [-1], [1.5], ["1"], [1, 1], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 101 }, (_, i) => i + 1)];
  for (const replaces of badValues) {
    const result = store.createDecision(p.projectId, { decision: "ok", replaces });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "replaces", JSON.stringify(replaces));
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decisions").get().n, 0);
});

test("replaces is a declaration: a not-yet-existing number is accepted and readable", (t) => {
  const store = storeFor(t);
  const p = project(store);
  // During a ledger migration the replaced decision may be imported later; the
  // store records the claim without resolving it (documented semantics).
  const created = dataOf(store.createDecision(p.projectId, { decision: "forward reference", replaces: [99999] }));
  assert.deepEqual(dataOf(store.getDecision(p.projectId, { decisionId: created.decisionId })).replaces, [99999]);
});

test("the default list separates temporary from long_term without a keyword", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const l1 = dataOf(store.createDecision(p.projectId, { decision: "long one" }));
  const t1 = dataOf(store.createDecision(p.projectId, { decision: "temp one", timeHorizon: "temporary" }));
  const l2 = dataOf(store.createDecision(p.projectId, { decision: "long two" }));
  const v1 = dataOf(store.createDecision(p.projectId, { decision: "voided temp", timeHorizon: "temporary" }));
  dataOf(store.voidDecision(p.projectId, { decisionId: v1.decisionId, expectedRevision: 1, reason: "done" }));

  // No query at all: the default list, recency order, effective only.
  const list = dataOf(store.searchDecisions(p.projectId, {}));
  assert.deepEqual(list.decisions.map((d) => d.decisionId), [l2.decisionId, t1.decisionId, l1.decisionId]);
  assert.ok(list.decisions.every((d) => d.timeHorizon === "long_term" || d.timeHorizon === "temporary"));
  assert.equal(list.hasMore, false);

  const temporary = dataOf(store.searchDecisions(p.projectId, { timeHorizon: "temporary" }));
  assert.deepEqual(temporary.decisions.map((d) => d.decisionId), [t1.decisionId]);
  const longTerm = dataOf(store.searchDecisions(p.projectId, { timeHorizon: "long_term" }));
  assert.deepEqual(longTerm.decisions.map((d) => d.decisionId), [l2.decisionId, l1.decisionId]);

  const withVoided = dataOf(store.searchDecisions(p.projectId, { timeHorizon: "temporary", includeVoided: true }));
  assert.deepEqual(withVoided.decisions.map((d) => d.decisionId), [v1.decisionId, t1.decisionId]);

  // Paging works on the default list exactly like on keyword search.
  const page1 = dataOf(store.searchDecisions(p.projectId, { limit: 2 }));
  assert.deepEqual(page1.decisions.map((d) => d.decisionId), [l2.decisionId, t1.decisionId]);
  assert.equal(page1.hasMore, true);
  const page2 = dataOf(store.searchDecisions(p.projectId, { limit: 2, offset: 2 }));
  assert.deepEqual(page2.decisions.map((d) => d.decisionId), [l1.decisionId]);
  assert.equal(page2.hasMore, false);

  // Keyword search combines with the horizon filter; items carry timeHorizon.
  const filtered = dataOf(store.searchDecisions(p.projectId, { query: "one", timeHorizon: "temporary" }));
  assert.deepEqual(filtered.decisions.map((d) => d.decisionId), [t1.decisionId]);
  assert.equal(filtered.decisions[0].timeHorizon, "temporary");
});

test("the default list validates like search and keeps the frozen rejections", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "seed" }));
  const unknown = store.searchDecisions(p.projectId, { mystery: 1 });
  errorOf(unknown, "VALIDATION_FAILED");
  assert.equal(unknown.error.field, "mystery");
  for (const [input, field] of [
    [{ limit: 0 }, "limit"],
    [{ limit: 21 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ offset: -1 }, "offset"],
    [{ includeVoided: "yes" }, "includeVoided"],
    [{ timeHorizon: "forever" }, "timeHorizon"],
    [{ timeHorizon: null }, "timeHorizon"],
  ]) {
    const result = store.searchDecisions(p.projectId, input);
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, field, JSON.stringify(input));
  }
  // An EMPTY query string is still rejected (omission is the way to list).
  const emptyQuery = store.searchDecisions(p.projectId, { query: "" });
  errorOf(emptyQuery, "VALIDATION_FAILED");
  assert.equal(emptyQuery.error.field, "query");
  // Non-object input keeps the frozen parser's canonical error.
  const nonObject = store.searchDecisions(p.projectId, "seed");
  errorOf(nonObject, "VALIDATION_FAILED");
});

test("update and void never touch externalId/replaces; snapshots keep the frozen shape", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const old = dataOf(store.createDecision(p.projectId, { decision: "old" }));
  const created = dataOf(store.createDecision(p.projectId, {
    decision: "v1",
    externalId: "D-500",
    replaces: [old.decisionId],
    refs: [{ type: "task", id: "T-500" }],
  }));
  dataOf(store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, patch: { decision: "v2" } }));
  dataOf(store.voidDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 2, reason: "done" }));
  const current = dataOf(store.getDecision(p.projectId, { decisionId: created.decisionId }));
  assert.equal(current.externalId, "D-500");
  assert.deepEqual(current.replaces, [old.decisionId]);
  assert.equal(current.status, "voided");
  const history = dataOf(store.getDecisionHistory(p.projectId, created.decisionId));
  assert.equal(history.length, 2);
  for (const entry of history) {
    assert.ok(!("externalId" in entry.snapshot), "snapshots keep the frozen DecisionRecord shape");
    assert.ok(!("replaces" in entry.snapshot));
  }
  // The refs edge survives the void (it documents the decision's references).
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs WHERE decision_id = ?").get(created.decisionId).n, 1);
  // externalId/replaces are not updatable through the frozen patch face.
  const patchKey = store.updateDecision(p.projectId, { decisionId: old.decisionId, expectedRevision: 1, patch: { externalId: "D-999" } });
  errorOf(patchKey, "VALIDATION_FAILED");
});

// ---------------------------------------------------------------------------
// task-393 ③: the refs-of query surface. decision_get carries the decision's
// own edges ("does this decision have a downstream task", requirements §11
// item 3); decision_search's refType/refId filter is the reverse direction
// ("which decisions reference this key"), served by idx_decision_refs_reverse.
// ---------------------------------------------------------------------------

test("getDecision returns the decision's refs and answers exists/not-exists by type", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const withRefs = dataOf(store.createDecision(p.projectId, {
    decision: "has downstream",
    refs: [{ type: "task", id: "T-194" }, { type: "decision", id: "D-1119" }],
  }));
  const got = dataOf(store.getDecision(p.projectId, { decisionId: withRefs.decisionId }));
  assert.deepEqual(got.refs, [{ type: "task", id: "T-194" }, { type: "decision", id: "D-1119" }]);
  assert.equal(got.refs.some((ref) => ref.type === "task"), true, "this decision HAS a downstream task");

  const bare = dataOf(store.createDecision(p.projectId, { decision: "no downstream" }));
  const bareGot = dataOf(store.getDecision(p.projectId, { decisionId: bare.decisionId }));
  assert.deepEqual(bareGot.refs, [], "no refs reads as an empty list, not null");
  assert.equal(bareGot.refs.some((ref) => ref.type === "task"), false, "this decision has NO downstream task");
});

test("search refType/refId is the reverse query: hit, empty, and combined filters", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const a = dataOf(store.createDecision(p.projectId, { decision: "alpha task work", refs: [{ type: "task", id: "T-194" }] }));
  const b = dataOf(store.createDecision(p.projectId, { decision: "beta task work", timeHorizon: "temporary", refs: [{ type: "task", id: "T-194" }, { type: "plan", id: "PLAN-0769" }] }));
  dataOf(store.createDecision(p.projectId, { decision: "gamma other task", refs: [{ type: "task", id: "T-999" }] }));
  const d = dataOf(store.createDecision(p.projectId, { decision: "delta voided", refs: [{ type: "task", id: "T-194" }] }));
  dataOf(store.voidDecision(p.projectId, { decisionId: d.decisionId, expectedRevision: 1, reason: "done" }));

  // Hit: exactly the decisions carrying the (task, T-194) edge, recency order.
  const hits = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-194" }));
  assert.deepEqual(hits.decisions.map((x) => x.decisionId), [b.decisionId, a.decisionId]);
  assert.equal(hits.hasMore, false);

  // Empty: a key nothing references answers an empty page, not an error.
  const empty = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-000" }));
  assert.deepEqual(empty.decisions, []);
  assert.equal(empty.hasMore, false);
  // Direction consistency: no decision can reference bl, so a bl-style key
  // under any valid type is empty too (the edge cannot exist).
  const blKey = dataOf(store.searchDecisions(p.projectId, { refType: "decision", refId: "BL-584" }));
  assert.deepEqual(blKey.decisions, []);

  // The type coordinate matters: same key under plan matches only b.
  const planHits = dataOf(store.searchDecisions(p.projectId, { refType: "plan", refId: "PLAN-0769" }));
  assert.deepEqual(planHits.decisions.map((x) => x.decisionId), [b.decisionId]);

  // Combines with keyword, horizon, and voided inclusion.
  const kw = dataOf(store.searchDecisions(p.projectId, { query: "alpha", refType: "task", refId: "T-194" }));
  assert.deepEqual(kw.decisions.map((x) => x.decisionId), [a.decisionId]);
  const temp = dataOf(store.searchDecisions(p.projectId, { timeHorizon: "temporary", refType: "task", refId: "T-194" }));
  assert.deepEqual(temp.decisions.map((x) => x.decisionId), [b.decisionId]);
  const withVoided = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-194", includeVoided: true }));
  assert.deepEqual(withVoided.decisions.map((x) => x.decisionId), [d.decisionId, b.decisionId, a.decisionId]);

  // Paging works on the reverse query like on every other search.
  const page1 = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-194", limit: 1 }));
  assert.deepEqual(page1.decisions.map((x) => x.decisionId), [b.decisionId]);
  assert.equal(page1.hasMore, true);
  const page2 = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-194", limit: 1, offset: 1 }));
  assert.deepEqual(page2.decisions.map((x) => x.decisionId), [a.decisionId]);
  assert.equal(page2.hasMore, false);

  // The reverse query is project-scoped like every other search.
  const other = project(store, "Borealis", "borealis");
  dataOf(store.createDecision(other.projectId, { decision: "foreign", refs: [{ type: "task", id: "T-194" }] }));
  const scoped = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-194" }));
  assert.equal(scoped.decisions.length, 2, "another project's edge does not leak in");
});

test("the reverse filter keeps the direction rule: bl is not a filter type", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "seed", refs: [{ type: "task", id: "T-1" }] }));
  const reversed = store.searchDecisions(p.projectId, { refType: "bl", refId: "BL-584" });
  errorOf(reversed, "VALIDATION_FAILED");
  assert.equal(reversed.error.field, "refType");
  assert.match(reversed.error.message, /direction rule/i);
  for (const badType of ["issue", "", null, 42, {}]) {
    const result = store.searchDecisions(p.projectId, { refType: badType, refId: "T-1" });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "refType", JSON.stringify(badType));
  }
});

test("the reverse filter requires both coordinates and validates refId", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const halfType = store.searchDecisions(p.projectId, { refType: "task" });
  errorOf(halfType, "VALIDATION_FAILED");
  assert.equal(halfType.error.field, "refId");
  const halfId = store.searchDecisions(p.projectId, { refId: "T-194" });
  errorOf(halfId, "VALIDATION_FAILED");
  assert.equal(halfId.error.field, "refType");
  // Explicit undefined is omission, not a half filter.
  const omitted = dataOf(store.searchDecisions(p.projectId, { refType: undefined, refId: undefined }));
  assert.equal(omitted.decisions.length, 0);
  for (const badId of ["", "   ", "a\u0000b", "x".repeat(201), 194, null, {}]) {
    const result = store.searchDecisions(p.projectId, { refType: "task", refId: badId });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "refId", JSON.stringify(badId));
  }
  // The reverse filter also works on the keyword path's validation surface.
  const withQuery = store.searchDecisions(p.projectId, { query: "seed", refType: "task" });
  errorOf(withQuery, "VALIDATION_FAILED");
  assert.equal(withQuery.error.field, "refId");
});

test("refs are add-only after create (task-405 evolves task-393): update/void keep them, snapshots exclude them", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, { decision: "v1", refs: [{ type: "commit", id: "a1b2c3d" }] }));
  dataOf(store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, patch: { decision: "v2" } }));
  dataOf(store.voidDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 2, reason: "done" }));
  const current = dataOf(store.getDecision(p.projectId, { decisionId: created.decisionId }));
  assert.deepEqual(current.refs, [{ type: "commit", id: "a1b2c3d" }]);
  const history = dataOf(store.getDecisionHistory(p.projectId, created.decisionId));
  for (const entry of history) {
    assert.ok(!("refs" in entry.snapshot), "snapshots keep the frozen DecisionRecord shape");
  }
  // No input shape clears edges: an empty refs list is rejected, not applied.
  const patchRefs = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 3, patch: { refs: [] } });
  errorOf(patchRefs, "VALIDATION_FAILED");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs WHERE decision_id = ?").get(created.decisionId).n, 1);
});

// --------------------------------------------------- task-405 refs add-only append

test("T405: patch.refs appends edges after create, bumps revision, reports refs in changedFields", (t) => {
  const store = storeFor(t);
  const p = project(store);
  // XH rules first, dispatches later: the task edge is known only after create.
  const created = dataOf(store.createDecision(p.projectId, { decision: "rule first", refs: [{ type: "decision", id: "D-1245" }] }));
  const appended = dataOf(store.updateDecision(p.projectId, {
    decisionId: created.decisionId, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-405" }] },
  }));
  assert.equal(appended.revision, 2, "refs-only append advances the revision");
  assert.deepEqual(appended.changedFields, ["refs"]);
  const got = dataOf(store.getDecision(p.projectId, { decisionId: created.decisionId }));
  assert.deepEqual(got.refs, [{ type: "decision", id: "D-1245" }, { type: "task", id: "T-405" }], "existing edge kept, new edge appended in order");
  assert.equal(got.decision, "rule first", "content untouched by a refs-only append");
  const history = dataOf(store.getDecisionHistory(p.projectId, created.decisionId));
  assert.equal(history.length, 1, "the append creates one snapshot (create itself has none)");
  assert.equal(history[0].changeKind, "update");
  assert.equal(history[0].snapshot.decision, "rule first", "snapshot keeps the pre-append content");
  for (const entry of history) assert.ok(!("refs" in entry.snapshot), "snapshots keep the frozen shape");
  const reverse = dataOf(store.searchDecisions(p.projectId, { refType: "task", refId: "T-405" }));
  assert.deepEqual(reverse.decisions.map((d) => d.decisionId), [created.decisionId], "reverse index answers the appended edge");
});

test("T405: duplicate append is a no-op; partial duplicates add only the new edges", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, { decision: "seed", refs: [{ type: "task", id: "T-1" }] }));
  const dup = dataOf(store.updateDecision(p.projectId, {
    decisionId: created.decisionId, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-1" }] },
  }));
  assert.equal(dup.revision, 1, "an already-present edge changes nothing");
  assert.deepEqual(dup.changedFields, []);
  const partial = dataOf(store.updateDecision(p.projectId, {
    decisionId: created.decisionId, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-1" }, { type: "plan", id: "PLAN-0779" }] },
  }));
  assert.equal(partial.revision, 2);
  assert.deepEqual(partial.changedFields, ["refs"]);
  const got = dataOf(store.getDecision(p.projectId, { decisionId: created.decisionId }));
  assert.deepEqual(got.refs, [{ type: "task", id: "T-1" }, { type: "plan", id: "PLAN-0779" }]);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs WHERE decision_id = ?").get(created.decisionId).n, 2, "no duplicate edge row");
});

test("T405: mixed content+refs patch reports both; unchanged content with new refs still bumps", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, { decision: "same text" }));
  const mixed = dataOf(store.updateDecision(p.projectId, {
    decisionId: created.decisionId, expectedRevision: 1,
    patch: { summary: "short", refs: [{ type: "commit", id: "abc1234" }] },
  }));
  assert.equal(mixed.revision, 2);
  assert.deepEqual(mixed.changedFields, ["summary", "refs"]);
  const sameContent = dataOf(store.updateDecision(p.projectId, {
    decisionId: created.decisionId, expectedRevision: 2,
    patch: { decision: "same text", refs: [{ type: "task", id: "T-9" }] },
  }));
  assert.equal(sameContent.revision, 3, "new edges bump even when content is unchanged");
  assert.deepEqual(sameContent.changedFields, ["refs"], "unchanged content is not reported");
});

test("T405: append validates like create — direction rule, shapes, atomicity", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, { decision: "base", refs: [{ type: "task", id: "T-1" }] }));
  const before = store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n;
  const badLists = [
    [{ type: "bl", id: "BL-584" }],
    [{ type: "task", id: "T-1" }, { type: "bl", id: "BL-2" }],
    null,
    "T-2",
    [null],
    [{ type: "task" }],
    [{ type: "task", id: "T-2", extra: 1 }],
    [{ type: "task", id: "T-2" }, { type: "task", id: "T-2" }],
    [],
  ];
  for (const refs of badLists) {
    const result = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, patch: { refs } });
    errorOf(result, "VALIDATION_FAILED");
    assert.equal(result.error.field, "refs", JSON.stringify(refs));
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, before, "no partial edge survives a rejected append");
  // Envelope discipline on the refs-only path mirrors the frozen parser.
  const unknownTop = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-2" }] }, extra: 1 });
  errorOf(unknownTop, "VALIDATION_FAILED");
  const badId = store.updateDecision(p.projectId, { decisionId: 0, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-2" }] } });
  errorOf(badId, "VALIDATION_FAILED");
  assert.equal(badId.error.field, "decisionId");
  const got = dataOf(store.getDecision(p.projectId, { decisionId: created.decisionId }));
  assert.deepEqual(got.refs, [{ type: "task", id: "T-1" }], "original edges untouched by every rejection");
});

test("T405: append respects the revision, editability and existence gates", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const created = dataOf(store.createDecision(p.projectId, { decision: "gated" }));
  const stale = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 99, patch: { refs: [{ type: "task", id: "T-1" }] } });
  errorOf(stale, "REVISION_CONFLICT");
  const missing = store.updateDecision(p.projectId, { decisionId: 999, expectedRevision: 1, patch: { refs: [{ type: "task", id: "T-1" }] } });
  errorOf(missing, "DECISION_NOT_FOUND");
  dataOf(store.voidDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 1, reason: "done" }));
  const voided = store.updateDecision(p.projectId, { decisionId: created.decisionId, expectedRevision: 2, patch: { refs: [{ type: "task", id: "T-1" }] } });
  errorOf(voided, "DECISION_NOT_EDITABLE");
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM decision_refs").get().n, 0, "no gate failure leaves an edge");
});

test("T406: search hits carry externalId so ledger D numbers identify results", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const withExt = dataOf(store.createDecision(p.projectId, { decision: "台账迁移查询面", externalId: "D-1245" }));
  const withoutExt = dataOf(store.createDecision(p.projectId, { decision: "台账迁移无外部键" }));
  const hits = dataOf(store.searchDecisions(p.projectId, { query: "台账迁移" })).decisions;
  assert.equal(hits.length, 2);
  const byId = new Map(hits.map((h) => [h.decisionId, h]));
  assert.equal(byId.get(withExt.decisionId).externalId, "D-1245", "外部键随命中项返回，无需逐条 get");
  assert.equal(byId.get(withoutExt.decisionId).externalId, null, "未设外部键为 null");
  // 既有字段语义不变（只增不改）。
  for (const h of hits) {
    assert.equal(typeof h.preview, "string");
    assert.equal(h.status, "effective");
    assert.equal(h.timeHorizon, "long_term");
  }
  // 反向 refs 查询的命中项同样带外部键。
  dataOf(store.updateDecision(p.projectId, { decisionId: withExt.decisionId, expectedRevision: 1, patch: { refs: [{ type: "plan", id: "PLAN-0779" }] } }));
  const reverse = dataOf(store.searchDecisions(p.projectId, { refType: "plan", refId: "PLAN-0779" })).decisions;
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].externalId, "D-1245");
});

// --- task-424 (D-1257): queryMode additive keyword search -------------------
// The frozen 377 literal substring stays the byte-identical default; keywords
// mode splits on whitespace and AND-es per-token literal-substring groups.

test("T424: default literal semantics unchanged — multi-word query is one exact substring", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "alpha beta gamma" }));
  const hits = (input) => dataOf(store.searchDecisions(p.projectId, input)).decisions;
  assert.equal(hits({ query: "alpha beta" }).length, 1, "exact phrase matches");
  assert.equal(hits({ query: "beta alpha" }).length, 0, "literal order matters");
  assert.equal(hits({ query: "alpha gamma" }).length, 0, "multi-word gap is still 0 hits by default");
  assert.equal(hits({ query: "alpha beta", queryMode: "literal" }).length, 1, "explicit literal = default");
});

test("T424: keywords mode AND-matches tokens in any order and across columns", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const a = dataOf(store.createDecision(p.projectId, { decision: "beta gamma", summary: "alpha" }));
  dataOf(store.createDecision(p.projectId, { decision: "alpha only" }));
  const hits = (input) => dataOf(store.searchDecisions(p.projectId, input)).decisions;
  const cross = hits({ query: "gamma alpha", queryMode: "keywords" });
  assert.deepEqual(cross.map((d) => d.decisionId), [a.decisionId], "one token in summary, one in decision, order-free");
  assert.equal(hits({ query: "alpha delta", queryMode: "keywords" }).length, 0, "every token must match");
  assert.deepEqual(hits({ query: "alpha", queryMode: "keywords" }), hits({ query: "alpha" }), "single token ≡ literal");
  assert.equal(hits({ query: "  alpha   gamma  ", queryMode: "keywords" }).length, 1, "extra whitespace drops empty tokens");
});

test("T424: keywords tokens stay literal substrings with the frozen LIKE case semantics", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "SQLite and café" }));
  const hits = (input) => dataOf(store.searchDecisions(p.projectId, input)).decisions;
  assert.equal(hits({ query: "sql", queryMode: "keywords" }).length, 1, "ASCII case-insensitive substring");
  assert.equal(hits({ query: "SQLITE", queryMode: "keywords" }).length, 1);
  assert.equal(hits({ query: "CAFÉ", queryMode: "keywords" }).length, 0, "non-ASCII case sensitivity inherited");
  dataOf(store.createDecision(p.projectId, { decision: "50%_off deal" }));
  assert.equal(hits({ query: "50%_off", queryMode: "keywords" }).length, 1, "percent/underscore stay literal");
  assert.equal(hits({ query: "50_off", queryMode: "keywords" }).length, 0, "no wildcard leakage per token");
});

test("T424: queryMode validation is fail-closed (four rejections)", (t) => {
  const store = storeFor(t);
  const p = project(store);
  dataOf(store.createDecision(p.projectId, { decision: "alpha beta" }));
  const badEnum = store.searchDecisions(p.projectId, { query: "alpha", queryMode: "fuzzy" });
  errorOf(badEnum, "VALIDATION_FAILED");
  assert.equal(badEnum.error.field, "queryMode");
  const noQuery = store.searchDecisions(p.projectId, { queryMode: "keywords" });
  errorOf(noQuery, "VALIDATION_FAILED");
  assert.equal(noQuery.error.field, "queryMode", "mode without query is refused, not ignored");
  const tooMany = store.searchDecisions(p.projectId, { query: Array.from({ length: 17 }, (_, i) => "w" + i).join(" "), queryMode: "keywords" });
  errorOf(tooMany, "VALIDATION_FAILED");
  assert.equal(tooMany.error.field, "query", "17 tokens exceed the 16-token cap");
  const blank = store.searchDecisions(p.projectId, { query: "   ", queryMode: "keywords" });
  errorOf(blank, "VALIDATION_FAILED");
  assert.equal(blank.error.field, "query", "blank query still dies in the frozen parser");
});

test("T424: the frozen parser still rejects queryMode — the extension lives outside the frozen seam", () => {
  const direct = parseDecisionSearchInput({ query: "alpha", queryMode: "keywords" });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, "VALIDATION_FAILED");
  assert.equal(direct.error.field, "queryMode", "frozen allowlist untouched");
  const base = parseDecisionSearchInput({ query: "alpha" });
  assert.equal(base.ok, true, "frozen base input unchanged");
});

test("T424: keywords composes with reverse refs, timeHorizon and pagination", (t) => {
  const store = storeFor(t);
  const p = project(store);
  const a = dataOf(store.createDecision(p.projectId, { decision: "alpha beta", externalId: "D-1" }));
  const b = dataOf(store.createDecision(p.projectId, { decision: "alpha gamma", timeHorizon: "temporary" }));
  const c = dataOf(store.createDecision(p.projectId, { decision: "alpha delta" }));
  dataOf(store.updateDecision(p.projectId, { decisionId: a.decisionId, expectedRevision: 1, patch: { refs: [{ type: "task", id: "task-424" }] } }));
  const hits = (input) => dataOf(store.searchDecisions(p.projectId, input)).decisions;
  const reverse = hits({ query: "alpha beta", queryMode: "keywords", refType: "task", refId: "task-424" });
  assert.deepEqual(reverse.map((d) => d.decisionId), [a.decisionId], "keywords + reverse refs");
  const temporary = hits({ query: "alpha", queryMode: "keywords", timeHorizon: "temporary" });
  assert.deepEqual(temporary.map((d) => d.decisionId), [b.decisionId], "keywords + timeHorizon");
  const page1 = hits({ query: "alpha", queryMode: "keywords", limit: 2, offset: 0 });
  const page2 = hits({ query: "alpha", queryMode: "keywords", limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 1, "keywords + pagination");
  assert.deepEqual([...page1, ...page2].map((d) => d.decisionId).sort(), [a.decisionId, b.decisionId, c.decisionId].sort());
});
