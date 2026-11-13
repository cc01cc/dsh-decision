/**
 * Trusted session→project binding service for the DSD plugin Host face
 * (PLAN-0778 T1.2).
 *
 * Contract anchors (`plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md`):
 * - `§2` line 78: every Agent tool derives its project from the current session's
 *   `session_id → project_id` binding; the caller must be a live runtime root and
 *   is refused before any business read/write.
 * - `§2` line 80: cancelling or timing out writes no project and performs no
 *   decision operation.
 * - `§2` line 82: selecting an existing project writes the binding; creating a
 *   project completes creation **and** binding in one transaction, and a failure
 *   persists neither.
 * - `§2` line 84: project creation accepts `{name, projectKey}` and returns
 *   `{projectId, name, projectKey}`; `projectId` is internal only.
 *
 * Standing rulings for this card:
 * - **D3**: record-level project scoping and the uniform `DECISION_NOT_FOUND`
 *   shape belong to PLAN-0779; this module only hands out the bound project id.
 * - **D4**: binding receipts keep the PLAN-0777 `SessionBindingRecord` shape
 *   (`projectId, name, projectKey, createdAt, updatedAt, sessionId`). No second
 *   shape is invented here.
 *
 * Fail-closed ordering: the caller is verified, and the session id is taken from
 * the verified identity, **before** the store is opened or read. No function here
 * accepts a session id from a caller-supplied argument — contract §2 line 78 says
 * a Client-supplied `sessionId` alone is not enough to authorize anything.
 */

import type { DomainErrorBody, DomainResult } from "../domain/decision-contract.ts";
import type { ProjectRecord, SessionBindingRecord } from "../storage/sqlite-store.ts";
import { requireCaller } from "./caller.ts";
import type { CallerSession, LiveAgentRegistry } from "./caller.ts";

/** The store surface this service consumes; `SQLiteDecisionStore` satisfies it. */
export interface BindingStore {
  listProjects(): DomainResult<ProjectRecord[]>;
  getBoundProject(sessionId: string): DomainResult<SessionBindingRecord | null>;
  bindSession(sessionId: string, projectId: unknown): DomainResult<SessionBindingRecord>;
  createAndBindProject(sessionId: string, projectInput: unknown): DomainResult<SessionBindingRecord>;
}

/**
 * A refusal raised by this Host face rather than by the domain layer.
 *
 * Caller problems are not domain error codes: the contract's code list
 * (`§3` line 348-353) describes business outcomes, while a missing or delegated
 * caller is a Host boundary event that happens before any business operation.
 * Keeping the two vocabularies apart stops a caller failure from being reported
 * as a business failure.
 */
export interface HostRefusal {
  readonly ok: false;
  /** `CALLER_REQUIRED` / `CALLER_NOT_LIVE` / `DELEGATED_CALLER` — see `caller.ts`. */
  readonly reason: string;
  readonly message: string;
}

export type BindingResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: DomainErrorBody }
  | HostRefusal;

/**
 * Verify the caller, then hand the verified session and the store to `operation`.
 *
 * `openStore` is a thunk so a refused caller never causes the store to be
 * opened, read, or even resolved — contract §2 line 78 "before reading/writing
 * business data". This is also what makes the three caller negatives testable
 * without a database: the test asserts the thunk is never invoked.
 */
function withVerifiedCaller<T>(
  agent: unknown,
  agents: LiveAgentRegistry,
  openStore: () => BindingStore,
  operation: (caller: CallerSession, store: BindingStore) => BindingResult<T>,
): BindingResult<T> {
  const decision = requireCaller(agent, agents);
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, message: decision.message };
  }
  return operation(decision.caller, openStore());
}

function toBindingResult<T>(result: DomainResult<T>): BindingResult<T> {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

/** Current binding for the verified caller's session (contract §2 line 82). */
export function getCurrentBinding(
  agent: unknown,
  agents: LiveAgentRegistry,
  openStore: () => BindingStore,
): BindingResult<SessionBindingRecord | null> {
  return withVerifiedCaller(agent, agents, openStore, (caller, store) =>
    toBindingResult(store.getBoundProject(caller.sessionId)),
  );
}

/** Projects a verified caller may pick from (the `name · key` list of contract §2 line 79). */
export function listSelectableProjects(
  agent: unknown,
  agents: LiveAgentRegistry,
  openStore: () => BindingStore,
): BindingResult<ProjectRecord[]> {
  return withVerifiedCaller(agent, agents, openStore, (caller, store) =>
    toBindingResult(store.listProjects()),
  );
}

/**
 * Bind the verified caller's session to an already existing project.
 *
 * Store semantics reused from PLAN-0777 (`bindSession`, `sqlite-store.ts:706`):
 * a repeated identical binding is idempotent, while a different project for an
 * already bound session is `VALIDATION_FAILED` on `sessionId`.
 */
export function bindExistingProject(
  agent: unknown,
  agents: LiveAgentRegistry,
  openStore: () => BindingStore,
  projectId: unknown,
): BindingResult<SessionBindingRecord> {
  return withVerifiedCaller(agent, agents, openStore, (caller, store) =>
    toBindingResult(store.bindSession(caller.sessionId, projectId)),
  );
}

/**
 * Create a project and bind the verified caller's session to it, atomically.
 *
 * Store semantics reused from PLAN-0777 (`createAndBindProject`,
 * `sqlite-store.ts:633`): both rows commit in one transaction and any failure
 * rolls the project back too — contract §2 line 82. The receipt is the PLAN-0777
 * `SessionBindingRecord` (ruling D4), not a second shape.
 */
export function createAndBindNewProject(
  agent: unknown,
  agents: LiveAgentRegistry,
  openStore: () => BindingStore,
  projectInput: unknown,
): BindingResult<SessionBindingRecord> {
  return withVerifiedCaller(agent, agents, openStore, (caller, store) =>
    toBindingResult(store.createAndBindProject(caller.sessionId, projectInput)),
  );
}
