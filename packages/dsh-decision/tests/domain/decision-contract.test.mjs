import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDecisionCreateBatchInput,
  parseDecisionCreateInput,
  parseDecisionGetInput,
  parseDecisionSearchInput,
  parseDecisionUpdateInput,
  parseDecisionVoidInput,
  parseProjectInput,
  parseProjectKey,
  parseProjectName,
} from "../../src/domain/decision-contract.ts";
import { suggestProjectKey } from "../../src/domain/project-key-suggestion.ts";

function valueOf(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function errorOf(result, field) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "VALIDATION_FAILED");
  if (field !== undefined) assert.equal(result.error.field, field);
  return result.error;
}

function assertSuggestedProjectKey(key) {
  assert.match(key, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(key.length >= 1 && key.length <= 48);
}

const validCreate = { decision: "Use SQLite." };

test("project key parser checks syntax only; Profile DB owns uniqueness", () => {
  assert.equal(valueOf(parseProjectKey("atlas-core")), "atlas-core");
  assert.equal(valueOf(parseProjectInput({ name: " Atlas ", projectKey: "atlas" })).name, "Atlas");
  assert.equal(valueOf(parseProjectInput({ name: "Atlas 2", projectKey: "atlas" })).projectKey, "atlas");
  for (const key of ["", "Atlas", "-atlas", "atlas-", "atlas--core", "atlas_core", "atlas core"]) {
    errorOf(parseProjectKey(key), "projectKey");
  }
  errorOf(parseProjectKey("a".repeat(49)), "projectKey");
  assert.equal(valueOf(parseProjectKey("a".repeat(48))).length, 48);
  errorOf(parseProjectInput({ name: "Atlas", projectKey: "atlas", extra: true }), "extra");
});

test("project name trims exactly the contract White_Space set", () => {
  const whitespace =
    "\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680" +
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
    "\u2028\u2029\u202f\u205f\u3000";
  assert.equal(valueOf(parseProjectName(`${whitespace}Atlas${whitespace}`)), "Atlas");
  errorOf(parseProjectName(whitespace), "name");
  // U+FEFF is outside the explicit trim set and therefore remains part of the name.
  assert.equal(valueOf(parseProjectName("\ufeffAtlas\ufeff")), "\ufeffAtlas\ufeff");
});

test("project name length counts Unicode code points and rejects line/control characters", () => {
  assert.equal(valueOf(parseProjectName("😀".repeat(64))), "😀".repeat(64));
  errorOf(parseProjectName("😀".repeat(65)), "name");
  errorOf(parseProjectName("A\nB"), "name");
  errorOf(parseProjectName("A\u2028B"), "name");
  errorOf(parseProjectName("A\u0000B"), "name");
  errorOf(parseProjectName("A\u0085B"), "name");
  errorOf(parseProjectName(42), "name");
});

test("create input rejects missing, mistyped, and unknown fields", () => {
  assert.deepEqual(errorOf(parseDecisionCreateInput({}), "decision"), {
    code: "VALIDATION_FAILED",
    message: "Expected a string.",
    field: "decision",
  });
  errorOf(parseDecisionCreateInput({ decision: 7 }), "decision");
  errorOf(parseDecisionCreateInput({ ...validCreate, decisionId: 1 }), "decisionId");
  errorOf(parseDecisionCreateInput({ decision: "ok", projectId: 1 }), "projectId");
  errorOf(parseDecisionCreateInput(null), "input");
  errorOf(parseDecisionCreateInput([validCreate]), "input");
});

test("create defaults timeHorizon to long_term and preserves nullable-field semantics", () => {
  // task-46：缺省唯一真相 = long_term（与工具描述、store 行为、生产库 1286 条一致）。
  assert.deepEqual(valueOf(parseDecisionCreateInput(validCreate)), {
    decision: "Use SQLite.",
    timeHorizon: "long_term",
  });
  const parsed = valueOf(parseDecisionCreateInput({
    decision: "Use SQLite.",
    summary: null,
    rationale: null,
    decisionDate: null,
    reviewDate: null,
    sourceReference: null,
  }));
  assert.equal(parsed.summary, null);
  assert.equal(parsed.rationale, null);
  assert.equal(parsed.decisionDate, null);
  assert.equal(parsed.reviewDate, null);
  assert.equal(parsed.sourceReference, null);
  errorOf(parseDecisionCreateInput({ decision: "ok", timeHorizon: null }), "timeHorizon");
  errorOf(parseDecisionCreateInput({ decision: "ok", summary: "" }), "summary");
  errorOf(parseDecisionCreateInput({ decision: "ok", summary: 1 }), "summary");
  errorOf(parseDecisionCreateInput({ decision: "ok", rationale: "  \u00a0" }), "rationale");
});

test("decision text length uses Unicode code points and rejects NUL", () => {
  assert.equal(valueOf(parseDecisionCreateInput({ decision: "😀".repeat(20_000) })).decision.length, 40_000);
  errorOf(parseDecisionCreateInput({ decision: "😀".repeat(20_001) }), "decision");
  errorOf(parseDecisionCreateInput({ decision: "A\u0000B" }), "decision");
  errorOf(parseDecisionCreateInput({ decision: " \u3000\t " }), "decision");
  assert.equal(valueOf(parseDecisionCreateInput({ decision: "  line one\nline two  " })).decision, "  line one\nline two  ");
  errorOf(parseDecisionCreateInput({ decision: "x", sourceReference: "r".repeat(4_001) }), "sourceReference");
});

test("date validators accept real calendar dates and nullable dates", () => {
  assert.equal(valueOf(parseDecisionCreateInput({ decision: "x", decisionDate: "2024-02-29" })).decisionDate, "2024-02-29");
  assert.equal(valueOf(parseDecisionCreateInput({ decision: "x", reviewDate: null })).reviewDate, null);
  for (const date of ["2023-02-29", "2024-02-30", "2024-13-01", "2024-00-10", "2024-1-01", "2024-01-01T00:00:00Z"]) {
    errorOf(parseDecisionCreateInput({ decision: "x", decisionDate: date }), "decisionDate");
  }
  errorOf(parseDecisionCreateInput({ decision: "x", decisionDate: 20240101 }), "decisionDate");
  errorOf(parseDecisionCreateInput({ decision: "x", decisionDate: undefined }), "decisionDate");
});

test("search parser applies defaults and strict numeric/boolean types", () => {
  assert.deepEqual(valueOf(parseDecisionSearchInput({ query: "  atlas  " })), {
    query: "  atlas  ",
    includeVoided: false,
    limit: 10,
    offset: 0,
  });
  assert.deepEqual(valueOf(parseDecisionSearchInput({ query: "x", includeVoided: true, limit: 20, offset: Number.MAX_SAFE_INTEGER })), {
    query: "x",
    includeVoided: true,
    limit: 20,
    offset: Number.MAX_SAFE_INTEGER,
  });
  errorOf(parseDecisionSearchInput({ query: "x", includeVoided: 1 }), "includeVoided");
  errorOf(parseDecisionSearchInput({ query: "x", limit: "10" }), "limit");
  errorOf(parseDecisionSearchInput({ query: "x", limit: 0 }), "limit");
  errorOf(parseDecisionSearchInput({ query: "x", limit: 1.5 }), "limit");
  errorOf(parseDecisionSearchInput({ query: "x", offset: -1 }), "offset");
  errorOf(parseDecisionSearchInput({ query: "x", offset: Number.MAX_SAFE_INTEGER + 1 }), "offset");
  errorOf(parseDecisionSearchInput({ query: "\u00a0" }), "query");
  errorOf(parseDecisionSearchInput({ query: "x", extra: false }), "extra");
});

test("get parser requires a positive integer without coercion", () => {
  assert.equal(valueOf(parseDecisionGetInput({ decisionId: 1 })).decisionId, 1);
  errorOf(parseDecisionGetInput({}), "decisionId");
  errorOf(parseDecisionGetInput({ decisionId: "1" }), "decisionId");
  errorOf(parseDecisionGetInput({ decisionId: 0 }), "decisionId");
  errorOf(parseDecisionGetInput({ decisionId: Number.MAX_SAFE_INTEGER + 1 }), "decisionId");
});

test("batch parser validates size and reports one-based itemIndex", () => {
  assert.equal(valueOf(parseDecisionCreateBatchInput({ decisions: [validCreate] })).decisions.length, 1);
  errorOf(parseDecisionCreateBatchInput({ decisions: [] }), "decisions");
  errorOf(parseDecisionCreateBatchInput({ decisions: Array.from({ length: 101 }, () => validCreate) }), "decisions");
  const error = errorOf(parseDecisionCreateBatchInput({ decisions: [validCreate, { decision: false }] }), "decision");
  assert.equal(error.itemIndex, 2);
  assert.equal(valueOf(parseDecisionCreateBatchInput({ decisions: Array.from({ length: 100 }, () => validCreate) })).decisions.length, 100);
});

test("update parser requires a non-empty patch and positive safe expectedRevision", () => {
  const input = { decisionId: 9, expectedRevision: 1, patch: { rationale: null } };
  assert.deepEqual(valueOf(parseDecisionUpdateInput(input)), input);
  assert.equal(valueOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: Number.MAX_SAFE_INTEGER, patch: { decision: "new" } })).expectedRevision, Number.MAX_SAFE_INTEGER);
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 0, patch: { decision: "x" } }), "expectedRevision");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1.1, patch: { decision: "x" } }), "expectedRevision");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: Number.MAX_SAFE_INTEGER + 1, patch: { decision: "x" } }), "expectedRevision");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1, patch: {} }), "patch");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1, patch: null }), "patch.input");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1, patch: { status: "voided" } }), "patch.status");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1, patch: { decision: null } }), "patch.decision");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1, patch: { timeHorizon: null } }), "patch.timeHorizon");
  errorOf(parseDecisionUpdateInput({ decisionId: 9, expectedRevision: 1, patch: { summary: "" } }), "summary");
});

test("void parser preserves reason text but checks its trimmed contents and bounds", () => {
  const reason = "  user requested withdrawal.  ";
  assert.equal(valueOf(parseDecisionVoidInput({ decisionId: 3, expectedRevision: 2, reason })).reason, reason);
  assert.equal(valueOf(parseDecisionVoidInput({ decisionId: 3, expectedRevision: 2, reason: "😀".repeat(1_000) })).reason.length, 2_000);
  errorOf(parseDecisionVoidInput({ decisionId: 3, expectedRevision: 2, reason: " \u00a0\t " }), "reason");
  errorOf(parseDecisionVoidInput({ decisionId: 3, expectedRevision: 2, reason: "x".repeat(1_001) }), "reason");
  errorOf(parseDecisionVoidInput({ decisionId: 3, expectedRevision: 2, reason: 3 }), "reason");
  errorOf(parseDecisionVoidInput({ decisionId: 3, expectedRevision: 2, reason: "x", confirm: true }), "confirm");
});

test("project key suggestion joins ASCII alphanumeric runs in lowercase", () => {
  const suggestion = suggestProjectKey("  Atlas.Core_v2!  ");
  assert.equal(suggestion, "atlas-core-v2");
  assertSuggestedProjectKey(suggestion);
});

test("project key suggestion keeps only ASCII fragments without transliterating", () => {
  const mixed = suggestProjectKey("中文 Atlas 2版");
  assert.equal(mixed, "atlas-2");
  assertSuggestedProjectKey(mixed);
  assert.equal(suggestProjectKey("纯中文 😀 !!!"), null);
  assert.equal(suggestProjectKey("---___..."), null);
});

test("project key suggestion proposes the smallest free collision suffix", () => {
  const base = "atlas-core";
  assert.equal(suggestProjectKey("Atlas Core"), base);
  assert.equal(suggestProjectKey("Atlas Core", [base]), "atlas-core-2");
  const occupied = [base, "atlas-core-2", "atlas-core-3"];
  const suggestion = suggestProjectKey("Atlas Core", occupied);
  assert.equal(suggestion, "atlas-core-4");
  assert.equal(suggestProjectKey("Atlas Core", occupied), suggestion);
  assertSuggestedProjectKey(suggestion);
});

test("project key suggestion truncates to 48 characters and strips a trailing separator", () => {
  const boundary = suggestProjectKey("a".repeat(48));
  assert.equal(boundary, "a".repeat(48));
  assertSuggestedProjectKey(boundary);

  const truncated = suggestProjectKey(`${"a".repeat(47)} b`);
  assert.equal(truncated, "a".repeat(47));
  assertSuggestedProjectKey(truncated);
});

test("project key collision suffix reserves space within the 48-character limit", () => {
  const base = "a".repeat(48);
  const suffixTwo = `${"a".repeat(46)}-2`;
  const suggestion = suggestProjectKey("a".repeat(60), [base, suffixTwo]);
  assert.equal(suggestion, `${"a".repeat(46)}-3`);
  assertSuggestedProjectKey(suggestion);
});
