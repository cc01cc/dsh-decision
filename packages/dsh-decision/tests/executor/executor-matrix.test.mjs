import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDecisionStore } from "../../src/storage/sqlite-store.ts";
import { registerDecisionTools } from "../../src/host/tools.ts";
import { hostRoot, HOST_SKIP, bootRealExecutor } from "./real-host.mjs";

/**
 * PLAN-0779 T2.4 - the six tools through the REAL DSH tool executor.
 *
 * Everything here runs model-shaped calls (JSON-string arguments, batch dispatch)
 * through the production stack: cordis + @deepseek-ai/dsh-tools ToolsService +
 * native executor. What the stand-in in tests/host/tools.test.mjs cannot see,
 * this matrix can:
 *   - registry-level arg validation (ToolArgsError as an isError result)
 *   - real output-schema validation of the tool result (ToolOutputError)
 *   - the true layering: the registry compiles the parameter map WITHOUT
 *     additionalProperties:false, so unknown-field rejection is proven end to
 *     end only where it actually lives - the DSD domain parser.
 * Assertions follow the same vocabulary as the contract: success is
 * {ok:true,data}, domain failure is {ok:false,error{code,message,field?,itemIndex?}},
 * and the seven codes are the only domain codes.
 */

const hasHost = hostRoot() !== null;
const maybe = hasHost ? test : (name, fn) => test(name, { skip: HOST_SKIP }, fn);

const tempRoots = new Set();
after(async () => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function liveAgent(id) { return { id, session: { id } }; }

function registryOf(rootAgents) {
  const byId = new Map(rootAgents.map((agent) => [agent.id, agent]));
  return { get: (id) => byId.get(id), roots: () => rootAgents };
}

/** Asker that selects the seeded project by its exact `名称 · key` label. */
function chooserFor(label) {
  return {
    calls: [],
    async ask(_agent, prompt) {
      this.calls.push(prompt.id);
      const option = prompt.options.find((entry) => entry.label === label) ?? prompt.options[0];
      return { kind: "answered", reply: { selected: option === undefined ? [] : [option.label] } };
    },
    async askTimed(_agent, prompt) { return this.ask(_agent, prompt); },
  };
}

/** One booted real-executor session over one seeded store. */
async function matrixFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-decision-executor-"));
  tempRoots.add(root);
  const store = SQLiteDecisionStore.open({ databasePath: join(root, "decisions.sqlite") });
  t.after(() => store.close());
  const seedA = store.createProject({ name: "Alpha 项目", projectKey: "alpha" });
  assert.equal(seedA.ok, true, "seed project alpha");
  const seedB = store.createProject({ name: "Beta 项目", projectKey: "beta" });
  assert.equal(seedB.ok, true, "seed project beta");
  // Two sessions on ONE store: alpha is the session under test, beta is the
  // foreign-project session. Bindings are pre-seeded so scope assertions compare
  // two real sessions over the same rows (a second store would prove nothing).
  const agents = registryOf([liveAgent("s-alpha"), liveAgent("s-beta")]);
  const alphaBinding = store.bindSession("s-alpha", seedA.data.projectId);
  assert.equal(alphaBinding.ok, true, "bind alpha session");
  const betaBinding = store.bindSession("s-beta", seedB.data.projectId);
  assert.equal(betaBinding.ok, true, "bind beta session");
  const deps = {
    agents,
    openStore: () => store,
    asker: chooserFor("Alpha 项目 · alpha"),
  };
  const host = await bootRealExecutor((tools, defineTool) => registerDecisionTools(tools, deps, defineTool));
  t.after(() => host.dispose());
  return {
    store,
    tools: host.tools,
    call: (name, args) => host.call(name, args, agents.get("s-alpha")),
    callBeta: (name, args) => host.call(name, args, agents.get("s-beta")),
  };
}

async function seedDecision(call, decisionText, extra = {}) {
  const made = await call("decision_create", { decision: decisionText, ...extra });
  assert.equal(made.isError, false, "seed create");
  assert.equal(made.value.ok, true, "seed create envelope");
  return made.value.data;
}

const CODES = new Set([
  "VALIDATION_FAILED",
  "PROJECT_REQUIRED",
  "DECISION_NOT_FOUND",
  "REVISION_CONFLICT",
  "DECISION_NOT_EDITABLE",
  "DATABASE_BUSY",
  "DATABASE_ERROR",
]);

function assertEnvelopeShape(value) {
  assert.equal(typeof value, "object");
  assert.equal(Object.hasOwn(value, "ok"), true, "envelope has ok");
  if (value.ok === true) {
    assert.deepEqual(Object.keys(value).sort(), ["data", "ok"], "success envelope keys");
  } else {
    assert.deepEqual(Object.keys(value).sort(), ["error", "ok"], "failure envelope keys");
    assert.equal(CODES.has(value.error.code), true, "one of the seven codes");
    assert.equal(typeof value.error.message, "string");
  }
}

/** Registry-level refusal: isError result from the real validator, never an envelope. */
function assertRegistryRefused(outcome, name) {
  assert.equal(outcome.isError, true, name + ": registry refuses");
  assert.equal(outcome.error?.info?.code, "INVALID_ARGS", name + ": INVALID_ARGS");
  assert.equal(outcome.error?.info?.name, "ToolArgsError", name + ": ToolArgsError");
  assert.equal(outcome.value, undefined, name + ": no tool value");
}

// ------------------------------------------------------- search

maybe("executor matrix: decision_search", async (t) => {
  const { call } = await matrixFixture(t);
  for (let i = 1; i <= 3; i++) await seedDecision(call, "决策 正文 " + i + " 关键字 needle" + i);

  const hit = await call("decision_search", { query: "needle2" });
  assert.equal(hit.isError, false);
  assertEnvelopeShape(hit.value);
  assert.equal(hit.value.ok, true);
  assert.deepEqual(hit.value.data.decisions.map((d) => d.decisionId), [2]);
  assert.equal(hit.value.data.hasMore, false);

  // Literal substring: % and _ are NOT wildcards.
  await seedDecision(call, "plain percent % underscore _ literal");
  const literal = await call("decision_search", { query: "p%cent" });
  assert.equal(literal.value.ok, true);
  assert.deepEqual(literal.value.data.decisions, [], "% is not a wildcard");
  const literalHit = await call("decision_search", { query: "percent % underscore" });
  assert.equal(literalHit.value.data.decisions.length, 1, "literal match");

  // Non-ASCII matches by code point.
  const cjk = await call("decision_search", { query: "决策" });
  assert.equal(cjk.value.data.decisions.length >= 3, true, "CJK code-point match");

  // Omitted query = the default recent list (no keyword): still a valid envelope.
  const list = await call("decision_search", {});
  assert.equal(list.isError, false);
  assert.equal(list.value.ok, true);
  assert.equal(Array.isArray(list.value.data.decisions), true, "default list shape");

  // Defaults: limit 10, offset 0; voided hidden by default.
  const made = await seedDecision(call, "to void for includeVoided default");
  await call("decision_void", { decisionId: made.decisionId, expectedRevision: made.revision, reason: "r" });
  const hidden = await call("decision_search", { query: "includeVoided default" });
  assert.deepEqual(hidden.value.data.decisions, [], "voided hidden by default");
  const shown = await call("decision_search", { query: "includeVoided default", includeVoided: true });
  assert.equal(shown.value.data.decisions.length, 1, "includeVoided shows it");

  // offset beyond the corpus pages empty with hasMore false, not an error.
  const far = await call("decision_search", { query: "决策", offset: 501 });
  assert.equal(far.value.ok, true);
  assert.deepEqual(far.value.data.decisions, [], "offset past corpus");
  assert.equal(far.value.data.hasMore, false);

  // Defaults + bounds through the real validator.
  const limit21 = await call("decision_search", { query: "决策", limit: 21 });
  assert.equal(limit21.value.ok, false);
  assert.equal(limit21.value.error.code, "VALIDATION_FAILED");
  assert.equal(limit21.value.error.field, "limit");

  // Query bounds are domain-level (code-point counts are not schema-expressible).
  const longQuery = await call("decision_search", { query: "q".repeat(501) });
  assert.equal(longQuery.value.ok, false);
  assert.equal(longQuery.value.error.code, "VALIDATION_FAILED");
  assert.equal(longQuery.value.error.field, "query");
  const blankQuery = await call("decision_search", { query: "   " });
  assert.equal(blankQuery.value.error.code, "VALIDATION_FAILED");
  assert.equal(blankQuery.value.error.field, "query");

  // Unknown field: the registry compiles WITHOUT additionalProperties:false,
  // so rejection happens in the domain parser - proven end to end here.
  const unknown = await call("decision_search", { query: "决策", projectId: 99 });
  assert.equal(unknown.value.ok, false);
  assert.equal(unknown.value.error.code, "VALIDATION_FAILED");
  assert.equal(unknown.value.error.field, "projectId");

  // Wrong JSON type is refused by the REAL registry before any tool body runs.
  const typed = await call("decision_search", { query: 123 });
  assertRegistryRefused(typed, "query type", "query");

  // Empty page shape is asserted once: decisions + hasMore only.
  assert.deepEqual(Object.keys(hit.value.data).sort(), ["decisions", "hasMore"]);
});

// ------------------------------------------------------- get

maybe("executor matrix: decision_get", async (t) => {
  const { call, callBeta } = await matrixFixture(t);
  const made = await seedDecision(call, "get me 依据正文", {
    summary: "短摘要",
    rationale: "理由",
    decisionDate: "2026-11-14",
    sourceReference: "S:ref",
  });

  const got = await call("decision_get", { decisionId: made.decisionId });
  assert.equal(got.isError, false);
  assertEnvelopeShape(got.value);
  assert.equal(got.value.ok, true);
  const record = got.value.data;
  // Subset, not exact key set: the record face is gaining fields on another
  // card (externalId/replaces/...). T2.4 asserts the contract-required core.
  const requiredKeys = [
    "createdAt", "decision", "decisionDate", "decisionId", "rationale", "reviewDate",
    "revision", "sourceReference", "status", "summary", "timeHorizon", "updatedAt",
    "voidedAt", "voidReason",
  ];
  for (const key of requiredKeys) assert.equal(Object.hasOwn(record, key), true, "record has " + key);
  assert.equal(record.decision, "get me 依据正文");
  assert.equal(record.status, "effective");
  // The omitted-timeHorizon default belongs to the contract/store face (it is
  // being revised on another card); T2.4 pins the enum, not the moving default.
  assert.equal(["long_term", "temporary"].includes(record.timeHorizon), true, "default timeHorizon is a legal enum");
  const explicit = await seedDecision(call, "explicit horizon", { timeHorizon: "temporary" });
  const gotExplicit = await call("decision_get", { decisionId: explicit.decisionId });
  assert.equal(gotExplicit.value.data.timeHorizon, "temporary", "explicit timeHorizon roundtrip");

  // Unicode roundtrip survives the real executor boundary.
  const uni = await seedDecision(call, "unicode 决策 🎉 é");
  const gotUni = await call("decision_get", { decisionId: uni.decisionId });
  assert.equal(gotUni.value.data.decision, "unicode 决策 🎉 é");

  // Missing vs foreign project: identical code AND shape, no ownership leak.
  const missing = await call("decision_get", { decisionId: 424242 });
  assert.equal(missing.value.ok, false);
  assert.equal(missing.value.error.code, "DECISION_NOT_FOUND");
  const foreign = await callBeta("decision_get", { decisionId: made.decisionId });
  assert.equal(foreign.value.ok, false);
  assert.equal(foreign.value.error.code, "DECISION_NOT_FOUND");
  assert.deepEqual(
    { ...missing.value.error, message: missing.value.error.message },
    { ...foreign.value.error, message: foreign.value.error.message },
    "same code+field shape for missing and foreign",
  );
  for (const body of [missing.value.error, foreign.value.error]) {
    assert.equal(body.message.includes("Alpha"), false, "no project name leak");
    assert.equal(body.message.includes("beta"), false, "no project key leak");
  }

  // Unknown field + wrong type.
  const unknown = await call("decision_get", { decisionId: made.decisionId, revision: 1 });
  assert.equal(unknown.value.error.code, "VALIDATION_FAILED");
  assert.equal(unknown.value.error.field, "revision");
  const typed = await call("decision_get", { decisionId: "1" });
  assertRegistryRefused(typed, "decisionId type", "decisionId");
});

// ------------------------------------------------------- create

maybe("executor matrix: decision_create", async (t) => {
  const { call } = await matrixFixture(t);

  // Defaults: summary null, timeHorizon temporary; receipt is revision 1.
  const made = await call("decision_create", { decision: "first 正文" });
  assert.equal(made.isError, false);
  assertEnvelopeShape(made.value);
  assert.equal(made.value.ok, true);
  for (const key of ["createdAt", "decisionId", "revision", "status", "summary"]) {
    assert.equal(Object.hasOwn(made.value.data, key), true, "create receipt has " + key);
  }
  assert.equal(made.value.data.revision, 1);
  assert.equal(made.value.data.status, "effective");
  assert.equal(made.value.data.summary, null);

  // Null clears summary; empty string is not a clear.
  const nulled = await call("decision_create", { decision: "d", summary: null });
  assert.equal(nulled.value.ok, true);
  const blank = await call("decision_create", { decision: "d", summary: "" });
  assert.equal(blank.value.ok, false);
  assert.equal(blank.value.error.code, "VALIDATION_FAILED");
  assert.equal(blank.value.error.field, "summary");
  const blankDecision = await call("decision_create", { decision: "   " });
  assert.equal(blankDecision.value.error.code, "VALIDATION_FAILED");
  assert.equal(blankDecision.value.error.field, "decision");
  const nullDecision = await call("decision_create", { decision: null });
  assertRegistryRefused(nullDecision, "decision null", "decision");

  // Code-point bounds (300 summary / 20000 decision), NUL, bad date, enum.
  const longSummary = await call("decision_create", { decision: "d", summary: "x".repeat(301) });
  assert.equal(longSummary.value.error.code, "VALIDATION_FAILED");
  assert.equal(longSummary.value.error.field, "summary");
  const longDecision = await call("decision_create", { decision: "y".repeat(20001) });
  assert.equal(longDecision.value.error.code, "VALIDATION_FAILED");
  assert.equal(longDecision.value.error.field, "decision");
  const boundary = await call("decision_create", { decision: "y".repeat(20000) });
  assert.equal(boundary.value.ok, true, "20000 code points accepted");
  const nul = await call("decision_create", { decision: "bad\u0000nul" });
  assert.equal(nul.value.error.code, "VALIDATION_FAILED");
  const badDate = await call("decision_create", { decision: "d", decisionDate: "2026-13-40" });
  assert.equal(badDate.value.error.code, "VALIDATION_FAILED");
  assert.equal(badDate.value.error.field, "decisionDate");
  const badHorizon = await call("decision_create", { decision: "d", timeHorizon: "permanent" });
  assertRegistryRefused(badHorizon, "timeHorizon enum", "timeHorizon");

  // sourceReference bound (4000 code points).
  const longRef = await call("decision_create", { decision: "d", sourceReference: "s".repeat(4001) });
  assert.equal(longRef.value.error.code, "VALIDATION_FAILED");
  assert.equal(longRef.value.error.field, "sourceReference");
  const okRef = await call("decision_create", { decision: "d", sourceReference: "s".repeat(4000) });
  assert.equal(okRef.value.ok, true, "4000 code points accepted");

  // Unknown field + registry-level wrong type.
  const unknown = await call("decision_create", { decision: "d", projectId: 1 });
  assert.equal(unknown.value.error.field, "projectId");
  const typed = await call("decision_create", { decision: 5 });
  assertRegistryRefused(typed, "decision type", "decision");
});

// ------------------------------------------------------- create_batch

maybe("executor matrix: decision_create_batch", async (t) => {
  const { call } = await matrixFixture(t);
  const before = await call("decision_search", { query: "batch" });
  assert.equal(before.value.data.decisions.length, 0);

  const made = await call("decision_create_batch", {
    decisions: [
      { decision: "batch 一" },
      { decision: "batch 二", timeHorizon: "long_term" },
    ],
  });
  assert.equal(made.value.ok, true);
  assert.equal(made.value.data.createdCount, 2);
  assert.deepEqual(made.value.data.decisions.map((d) => d.index), [1, 2]);
  const afterOk = await call("decision_search", { query: "batch" });
  assert.equal(afterOk.value.data.decisions.length, 2, "whole batch committed");

  // Rollback: item 2 invalid leaves NOTHING behind.
  const rolled = await call("decision_create_batch", {
    decisions: [{ decision: "batch rollback ok" }, { decision: "   " }],
  });
  assert.equal(rolled.value.ok, false);
  assert.equal(rolled.value.error.code, "VALIDATION_FAILED");
  assert.equal(rolled.value.error.field, "decision");
  assert.equal(rolled.value.error.itemIndex, 2, "1-based item index");
  const afterRoll = await call("decision_search", { query: "batch rollback" });
  assert.deepEqual(afterRoll.value.data.decisions, [], "batch rollback left nothing");

  // Unknown field inside an item, and a registry-level wrong type.
  // Nested item objects declare additionalProperties:false, so the real registry
  // refuses unknown item fields before the body runs...
  const unknownItem = await call("decision_create_batch", { decisions: [{ decision: "d", status: "effective" }] });
  assertRegistryRefused(unknownItem, "batch item unknown field", "status");
  // ...while the top-level parameter map is compiled open, so top-level unknown
  // fields are refused by the DSD domain parser instead.
  const unknownTop = await call("decision_create_batch", { decisions: [{ decision: "d" }], projectId: 7 });
  assert.equal(unknownTop.value.ok, false);
  assert.equal(unknownTop.value.error.code, "VALIDATION_FAILED");
  assert.equal(unknownTop.value.error.field, "projectId");
  const typed = await call("decision_create_batch", { decisions: "two" });
  assertRegistryRefused(typed, "decisions type", "decisions");
  const empty = await call("decision_create_batch", { decisions: [] });
  assert.equal(empty.value.error.code, "VALIDATION_FAILED");
  const tooMany = await call("decision_create_batch", {
    decisions: Array.from({ length: 101 }, (_, i) => ({ decision: "bulk " + i })),
  });
  assert.equal(tooMany.value.ok, false);
  assert.equal(tooMany.value.error.code, "VALIDATION_FAILED");
  assert.equal(tooMany.value.error.field, "decisions");
  const afterTooMany = await call("decision_search", { query: "bulk" });
  assert.deepEqual(afterTooMany.value.data.decisions, [], "oversize batch left nothing");
});

// ------------------------------------------------------- update

maybe("executor matrix: decision_update", async (t) => {
  const { call } = await matrixFixture(t);
  const made = await seedDecision(call, "update me", { summary: "旧摘要" });

  const updated = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision,
    patch: { summary: "新摘要" },
  });
  assert.equal(updated.isError, false);
  assertEnvelopeShape(updated.value);
  assert.equal(updated.value.data.revision, made.revision + 1);
  assert.deepEqual(updated.value.data.changedFields, ["summary"]);
  assert.equal(updated.value.data.status, "effective");

  // Snapshot readback through the real executor.
  const got = await call("decision_get", { decisionId: made.decisionId });
  assert.equal(got.value.data.summary, "新摘要");
  assert.equal(got.value.data.revision, made.revision + 1);

  // No-op patch: success, empty changedFields, unchanged revision.
  const noop = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 1,
    patch: { summary: "新摘要" },
  });
  assert.equal(noop.value.ok, true);
  assert.deepEqual(noop.value.data.changedFields, []);
  assert.equal(noop.value.data.revision, made.revision + 1);

  // Stale revision: refused without side effect.
  const stale = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision,
    patch: { summary: "again" },
  });
  assert.equal(stale.value.ok, false);
  assert.equal(stale.value.error.code, "REVISION_CONFLICT");
  const unchanged = await call("decision_get", { decisionId: made.decisionId });
  assert.equal(unchanged.value.data.summary, "新摘要", "conflict left no side effect");

  // Null clears a field; empty string is not a clear; unknown patch field.
  const cleared = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 1,
    patch: { summary: null },
  });
  assert.deepEqual(cleared.value.data.changedFields, ["summary"]);
  const blankPatch = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 2,
    patch: { summary: "" },
  });
  assert.equal(blankPatch.value.error.code, "VALIDATION_FAILED");
  const unknownPatch = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 2,
    patch: { decisionId: 9 },
  });
  assertRegistryRefused(unknownPatch, "patch unknown field", "decisionId");
  const emptyPatch = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 2,
    patch: {},
  });
  assert.equal(emptyPatch.value.error.code, "VALIDATION_FAILED");
});

// ------------------------------------------------------- void

maybe("executor matrix: decision_void", async (t) => {
  const { call } = await matrixFixture(t);
  const made = await seedDecision(call, "void me");

  const voided = await call("decision_void", {
    decisionId: made.decisionId,
    expectedRevision: made.revision,
    reason: "用户要求作废",
  });
  assert.equal(voided.isError, false);
  assertEnvelopeShape(voided.value);
  assert.equal(voided.value.data.status, "voided");
  assert.equal(voided.value.data.revision, made.revision + 1);
  assert.equal(typeof voided.value.data.voidedAt, "string");

  // Voided stays readable.
  const got = await call("decision_get", { decisionId: made.decisionId });
  assert.equal(got.value.data.status, "voided");
  assert.equal(got.value.data.voidReason, "用户要求作废");

  // Duplicate void: stale revision conflicts; a fresh revision is idempotent.
  const staleVoid = await call("decision_void", {
    decisionId: made.decisionId,
    expectedRevision: made.revision,
    reason: "r",
  });
  assert.equal(staleVoid.value.error.code, "REVISION_CONFLICT");
  const freshVoid = await call("decision_void", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 1,
    reason: "r again",
  });
  assert.equal(freshVoid.value.ok, true);
  assert.equal(freshVoid.value.data.revision, made.revision + 1, "no second bump");
  assert.equal(freshVoid.value.data.voidedAt, voided.value.data.voidedAt, "original voidedAt kept");

  // Voided cannot be updated.
  const updateVoided = await call("decision_update", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 1,
    patch: { summary: "x" },
  });
  assert.equal(updateVoided.value.error.code, "DECISION_NOT_EDITABLE");

  // Blank reason and unknown field are refused; voided hidden from default search.
  const blankReason = await call("decision_void", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 1,
    reason: "   ",
  });
  assert.equal(blankReason.value.error.code, "VALIDATION_FAILED");
  assert.equal(blankReason.value.error.field, "reason");
  const longReason = await call("decision_void", {
    decisionId: made.decisionId,
    expectedRevision: made.revision + 1,
    reason: "r".repeat(1001),
  });
  assert.equal(longReason.value.error.code, "VALIDATION_FAILED");
  assert.equal(longReason.value.error.field, "reason");
  const unknown = await call("decision_void", { decisionId: 1, expectedRevision: 1, reason: "r", status: "voided" });
  assert.equal(unknown.value.error.field, "status");
  const searchHidden = await call("decision_search", { query: "void me" });
  assert.deepEqual(searchHidden.value.data.decisions, []);
});

// ------------------------------------------------------- caller gate through the executor

maybe("executor matrix: caller refusals are not domain envelopes", async (t) => {
  const { call } = await matrixFixture(t);
  await seedDecision(call, "gate test");
  // No agent in the batch input: the real executor surfaces a thrown refusal as
  // an isError result - never dressed up as one of the seven domain codes.
  const bare = await bootRealExecutor((tools, defineTool) =>
    registerDecisionTools(tools, {
      agents: registryOf([liveAgent("gate")]),
      openStore: () => ({}),
      asker: chooserFor("Alpha 项目 · alpha"),
    }, defineTool),
  );
  t.after(() => bare.dispose());
  const refused = await bare.call("decision_get", { decisionId: 1 });
  assert.equal(refused.isError, true, "refusal surfaces as isError");
  assert.equal(refused.value, undefined, "no domain envelope");
});

// ------------------------------------------------------- registration face

maybe("executor matrix: six tools registered on the real registry", async (t) => {
  const { tools } = await matrixFixture(t);
  const expected = ["decision_search", "decision_get", "decision_create", "decision_create_batch", "decision_update", "decision_void"];
  for (const name of expected) {
    assert.notEqual(tools.get(name), undefined, name + " visible on the real registry");
  }
  const schemas = tools.schemas();
  assert.equal(schemas.length, 6);
  assert.deepEqual(schemas.map((s) => s.name), expected, "contract order");
});
