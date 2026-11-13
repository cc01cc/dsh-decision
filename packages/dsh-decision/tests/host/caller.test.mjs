import assert from "node:assert/strict";
import { test } from "node:test";
import { CALLER_REJECTIONS, requireCaller } from "../../src/host/caller.ts";

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
