import assert from "node:assert/strict";
import { test } from "node:test";
import { CALLER_REJECTIONS, adaptAgentRegistry, requireCaller } from "../../src/host/caller.ts";

/**
 * Caller gate L0 (PLAN-0778 A, contract §2 line 78).
 *
 * The three negatives must prove the gate REFUSES, not merely that a legal
 * input passes. Each negative also asserts the absence of any side effect: no
 * registry lookup happens for an unidentified caller, and no throw is used as
 * the refusal mechanism (a thrown error could be swallowed upstream and turn
 * into "no caller, continue anyway", which is exactly review finding B1).
 */

/** Fake registry mirroring `ctx.agents`: `get(id)` returns the exact live instance. */
function registryOf(rootAgents, childAgents = []) {
  const byId = new Map();
  for (const agent of [...rootAgents, ...childAgents]) byId.set(agent.id, agent);
  const lookups = [];
  return {
    lookups,
    get(id) {
      lookups.push(id);
      return byId.get(id);
    },
    roots() {
      return rootAgents;
    },
  };
}

function liveAgent(id) {
  return { id, session: { id } };
}

function assertRefused(result, reason) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, reason);
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
  return result;
}

test("rejects a missing caller before any registry lookup", () => {
  const registry = registryOf([]);
  for (const missing of [undefined, null, {}, "agent-1"]) {
    const result = requireCaller(missing, registry);
    assertRefused(result, "CALLER_REQUIRED");
  }
  // No lookup was attempted: a missing caller cannot be authorized by a lookup.
  assert.deepEqual(registry.lookups, []);
});

test("rejects an agent that is not the registry's exact live instance", () => {
  const live = liveAgent("session-a");
  const registry = registryOf([live]);
  const impostor = liveAgent("session-a"); // same id, different object
  const result = requireCaller(impostor, registry);
  assertRefused(result, "CALLER_NOT_LIVE");
  // The lookup did happen (id was identifiable), but identity comparison failed.
  assert.deepEqual(registry.lookups, ["session-a"]);

  // An id with no live entry at all is the same refusal class.
  const unknown = registryOf([]);
  const ghost = liveAgent("session-ghost");
  assertRefused(requireCaller(ghost, unknown), "CALLER_NOT_LIVE");
});

test("rejects a live agent that is owned by another agent (delegated caller)", () => {
  const root = liveAgent("session-root");
  const child = liveAgent("session-child");
  // The child IS live, but is not top-level: roots() excludes it.
  const registry = registryOf([root], [child]);
  const result = requireCaller(child, registry);
  assertRefused(result, "DELEGATED_CALLER");
  assert.deepEqual(registry.lookups, ["session-child"]);
});

test("accepts a live root agent and derives the session id from the verified identity", () => {
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  const result = requireCaller(root, registry);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.caller.sessionId, "session-root");
  assert.equal(result.caller.agent, root);
});

test("does not accept an agent id that cannot identify a session", () => {
  const registry = registryOf([]);
  for (const bad of [{ id: "" }, { id: "a\u0000b" }, { id: 7 }, {}, null, undefined]) {
    assertRefused(requireCaller(bad, registry), "CALLER_REQUIRED");
  }
});

test("throws only for a Host wiring bug, never for a caller problem", () => {
  for (const broken of [undefined, null, {}, { get() {} }, { roots() { return []; } }]) {
    assert.throws(() => requireCaller(liveAgent("session-root"), broken), TypeError);
  }
});

test("rejection vocabulary is exactly the three contract-relevant reasons", () => {
  assert.deepEqual([...CALLER_REJECTIONS], ["CALLER_REQUIRED", "CALLER_NOT_LIVE", "DELEGATED_CALLER"]);
});

// ---------------------------------------------------------------------------
// task-9 / D-1651 / D-1657: host registry shape adapter.
// rc.1 = get(id)+roots(); rc.3 = get(id)+list() with root-ness in the session
// header (origin / delegationDepth) and runtime options.subagentDepth — the
// exact facts dsh-subagent's delegationDepthOf/rootOf read (host source quoted
// in the task-9 evidence pack). The adapter must stay fail-closed: unreadable
// or invalid facts exclude an agent from roots(), never admit it.
// ---------------------------------------------------------------------------

/** rc.3-shaped fake: get(id) + list(); root-ness lives in header/options. */
function rc3RegistryOf(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const lookups = [];
  return {
    lookups,
    get(id) { lookups.push(id); return byId.get(id); },
    list() { return [...byId.values()]; },
  };
}

/** Agent shaped like the rc.3 Host's: session.header + options carry the facts. */
function rc3Agent(id, { header = {}, options = {} } = {}) {
  return { id, session: { id, header }, options };
}

test("task-9: rc.1 registry (get+roots) passes through unchanged", () => {
  const root = liveAgent("session-root");
  const registry = registryOf([root]);
  const adapted = adaptAgentRegistry(registry);
  assert.equal(adapted, registry, "known shape is used as-is, no wrapper");
  assert.equal(requireCaller(root, adapted).ok, true);
});

test("task-9: rc.3 registry (get+list) — roots() keeps only depth-0 non-subagent agents", () => {
  const root = rc3Agent("s-root", { header: { origin: "user" } });
  const child = rc3Agent("s-child", { header: { origin: "subagent", delegationDepth: 1 } });
  const deepened = rc3Agent("s-deep", { header: {}, options: { subagentDepth: 2 } });
  const adapted = adaptAgentRegistry(rc3RegistryOf([root, child, deepened]));
  assert.deepEqual(adapted.roots(), [root]);
  assert.equal(requireCaller(root, adapted).ok, true);
  assertRefused(requireCaller(child, adapted), "DELEGATED_CALLER");
  assertRefused(requireCaller(deepened, adapted), "DELEGATED_CALLER");
});

test("task-9: rc.3 root-ness is fail-closed on unreadable or invalid facts", () => {
  // Each fixture guards one mutation: dropping the origin check, dropping the
  // depth validation, or failing open on missing structure turns one red.
  const root = rc3Agent("s-root");
  const cases = [
    ["origin subagent at depth 0", rc3Agent("s-a", { header: { origin: "subagent" } })],
    ["negative header depth", rc3Agent("s-b", { header: { delegationDepth: -1 } })],
    ["non-integer header depth", rc3Agent("s-c", { header: { delegationDepth: 1.5 } })],
    ["string header depth", rc3Agent("s-d", { header: { delegationDepth: "1" } })],
    ["NaN runtime depth", rc3Agent("s-e", { options: { subagentDepth: NaN } })],
    ["negative runtime depth", rc3Agent("s-e2", { options: { subagentDepth: -2 } })],
    ["missing header", { id: "s-f", session: { id: "s-f" }, options: {} }],
    ["missing session", { id: "s-g", options: {} }],
    ["null header", { id: "s-h", session: { id: "s-h", header: null }, options: {} }],
  ];
  const adapted = adaptAgentRegistry(rc3RegistryOf([root, ...cases.map(([, agent]) => agent)]));
  assert.deepEqual(adapted.roots(), [root]);
  for (const [, agent] of cases) {
    assertRefused(requireCaller(agent, adapted), "DELEGATED_CALLER");
  }
});

test("task-9: rc.3 null depth reads as absent (mirrors host ?? 0)", () => {
  const root = rc3Agent("s-root", { header: { delegationDepth: null }, options: { subagentDepth: null } });
  const adapted = adaptAgentRegistry(rc3RegistryOf([root]));
  assert.deepEqual(adapted.roots(), [root]);
  assert.equal(requireCaller(root, adapted).ok, true);
});

test("task-9: rc.3 keeps exact-identity and no-caller semantics", () => {
  const root = rc3Agent("s-root");
  const registry = rc3RegistryOf([root]);
  const adapted = adaptAgentRegistry(registry);
  assertRefused(requireCaller(undefined, adapted), "CALLER_REQUIRED");
  assert.deepEqual(registry.lookups, []);
  assertRefused(requireCaller(rc3Agent("s-root"), adapted), "CALLER_NOT_LIVE");
  assertRefused(requireCaller(rc3Agent("s-ghost"), adapted), "CALLER_NOT_LIVE");
  const ok = requireCaller(root, adapted);
  assert.equal(ok.ok, true);
  assert.equal(ok.caller.sessionId, "s-root");
  assert.equal(ok.caller.agent, root);
});

test("task-9: unknown registry shapes still throw TypeError (wiring bug)", () => {
  for (const broken of [undefined, null, {}, "registry", { get() {} }, { list() { return []; } }, { roots() { return []; } }, { get: 1, roots() {} }]) {
    assert.throws(() => adaptAgentRegistry(broken), TypeError);
  }
});
