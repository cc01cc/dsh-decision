/**
 * Trusted-caller gate for the DSD plugin Host face (PLAN-0778 T1.2).
 *
 * Frozen contract anchors (`plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md`):
 * - `§2` line 78: caller policy is Root Agent + Host fail-closed. The Host must
 *   resolve the current live session from its own trusted context, never from a
 *   `sessionId` a Client supplies on its own; a missing or delegated caller is
 *   refused **before** any business read or write.
 * - `§2` line 84: the six Agent tools receive no `projectId`/`projectKey`
 *   parameter, so the project scope must come from this trusted binding.
 *
 * Why this module exists instead of relying on the Host's own guard (PLAN-0778
 * review round-1 finding B1): the built-in `userQuestions.ask()`
 * (`@deepseek-ai/dsh-user-questions/lib/index.js:679-680`, `0.2.2-rc.1`) only
 * runs `assertLiveRoot()` when `request.agent !== undefined`; with no agent it
 * silently continues into the unscoped `user-questions/request` waterfall
 * (`:707-712`). A missing caller therefore does NOT fail closed there — it can
 * be absorbed by any unscoped listener. The same source shows `exec.agent`
 * is an optional field on `ToolBatchInput` (`@deepseek-ai/dsh-tools/lib/pipeline.js:28-43`)
 * and is not a credential, so an A12 handler must decide for itself.
 *
 * The gate therefore rejects on its own, before any question or store access:
 * 1. no identifiable caller object at all;
 * 2. an identifiable caller that is not the registry's exact live instance
 *    (`agents.get(id) === agent`);
 * 3. a live instance that is not a runtime root (`agents.roots()` membership).
 *
 * Conditions 2 and 3 mirror the two halves of the built-in `assertLiveRoot()`
 * (`dsh-user-questions/lib/index.js:539-543`) and of M0 §21 line 343
 * (`evidence/m0-runtime-research.md`), so the A12 vocabulary matches the Host's.
 */

/** Caller rejection reasons. These are Host boundary refusals, not domain codes. */
export const CALLER_REJECTIONS = [
  "CALLER_REQUIRED",
  "CALLER_NOT_LIVE",
  "DELEGATED_CALLER",
] as const;

export type CallerRejection = (typeof CALLER_REJECTIONS)[number];

/**
 * The minimal live-agent registry surface this gate needs.
 *
 * Declared structurally so the real `ctx.agents` service satisfies it as-is:
 * `@deepseek-ai/dsh-agent/lib/index.js:725-727` (`get(id)` returns the exact
 * live agent) and `:752-754` (`roots()` returns `entry.owner === undefined`
 * agents, a fresh array). Tests inject a fake of the same shape.
 */
export interface LiveAgentRegistry {
  get(id: string): unknown;
  roots(): readonly unknown[];
}

/**
 * A caller that passed the gate.
 *
 * Not constructible from outside this module's own success path, so binding
 * operations (see `binding.ts`) cannot be reached without a trusted caller.
 * `sessionId` is taken from the Host-verified agent identity, never from client
 * input — contract §2 line 78.
 */
export interface CallerSession {
  /** Verified live root agent id, which the Host uses as the session id. */
  readonly sessionId: string;
  /** The exact verified agent instance, kept for later Host operations. */
  readonly agent: unknown;
}

export type CallerDecision =
  | { readonly ok: true; readonly caller: CallerSession }
  | { readonly ok: false; readonly reason: CallerRejection; readonly message: string };

/** Candidate caller must expose a usable id (`Agent.id` is the SessionId). */
function identifiableAgentId(agent: unknown): string | null {
  if (typeof agent !== "object" || agent === null) return null;
  const candidate = agent as { readonly id?: unknown };
  if (typeof candidate.id !== "string") return null;
  if (candidate.id.length === 0 || candidate.id.includes("\u0000")) return null;
  return candidate.id;
}

/** A registry that cannot answer both questions is a Host wiring bug, not a caller problem. */
function assertUsableRegistry(agents: unknown): asserts agents is LiveAgentRegistry {
  if (typeof agents !== "object" || agents === null) {
    throw new TypeError("The live agent registry must be supplied; the caller gate cannot verify a caller without it.");
  }
  const registry = agents as Partial<LiveAgentRegistry>;
  if (typeof registry.get !== "function" || typeof registry.roots !== "function") {
    throw new TypeError("The live agent registry must expose get(id) and roots(); the caller gate cannot verify a caller without them.");
  }
}

/**
 * Decide whether a Host-supplied caller may act on the current Profile.
 *
 * Pure and side-effect free: reads only through the injected registry, never
 * touches a store, a question, or the filesystem. The order is load bearing —
 * an unidentified caller is rejected without even a registry lookup, so nothing
 * downstream can absorb it.
 *
 * @param agent - the raw `exec.agent` (optional on `ToolBatchInput`, so `undefined` is normal input).
 * @param agents - the Host live-agent registry (`ctx.agents`).
 * @returns a caller decision; never throws for caller problems.
 * @throws {TypeError} when the registry itself is missing or unusable (wiring bug).
 */
export function requireCaller(agent: unknown, agents: LiveAgentRegistry): CallerDecision {
  assertUsableRegistry(agents);

  const id = identifiableAgentId(agent);
  if (id === null) {
    return {
      ok: false,
      reason: "CALLER_REQUIRED",
      message: "A live root agent is required; the Host supplied no identifiable caller.",
    };
  }

  const live = agents.get(id);
  if (live === undefined || live !== agent) {
    return {
      ok: false,
      reason: "CALLER_NOT_LIVE",
      message: "The supplied agent is not the registry's live instance for this session.",
    };
  }

  if (!agents.roots().includes(agent)) {
    return {
      ok: false,
      reason: "DELEGATED_CALLER",
      message: "The supplied agent is owned by another agent and may not write to this Profile.",
    };
  }

  return { ok: true, caller: { sessionId: id, agent } };
}
