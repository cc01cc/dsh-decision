/**
 * The six DSD Agent tools (PLAN-0779 T2.1/T2.3, rulings D1/D3).
 *
 * Every tool obtains its project through the single outlet PLAN-0778 established
 * (`resolveSessionProject`) — no tool resolves the binding itself, so a session's
 * project is decided in one place and the six tools cannot drift apart on scope
 * (ruling D1: one reusable provider, not a per-tool private path).
 *
 * Frozen contract anchors (plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md):
 * - line 88: inputs are validated at the Host boundary from `unknown`, without
 *   coercion, and undeclared fields are rejected; projectId/decisionId/revision/
 *   status/timestamps never come from the model.
 * - line 108: success is `{ok:true,data}`, failure is `{ok:false,error}`; error text
 *   never contains decision bodies, rationale, or source text.
 * - lines 110-316: per-tool input fields, bounds, and result shapes.
 * - lines 348-353: the seven domain error codes.
 * - line 350: a decision that is missing, in another Profile DB, or in another
 *   project returns the SAME DECISION_NOT_FOUND code/shape, leaking no ownership
 *   (T2.3).
 *
 * Caller refusals are NOT domain codes. The contract's error table has no slot for
 * them, so a refused caller is not dressed up as a domain envelope: it throws a
 * refusal error instead, after the caller gate and before any store access
 * (PLAN-0778 T1.2 semantics). Cancellation/timeout at the project question is
 * different — that IS project selection, so it returns the domain envelope with
 * PROJECT_REQUIRED (line 348).
 */

import type { DecisionRecord, DomainErrorBody, DomainResult } from "../domain/decision-contract.ts";
import type {
  DecisionBatchReceipt,
  DecisionCreateReceipt,
  DecisionRevisionRecord,
  DecisionSearchPage,
  DecisionUpdateReceipt,
  DecisionVoidReceipt,
} from "../storage/sqlite-store.ts";
import type { CallerSession, LiveAgentRegistry } from "./caller.ts";
import { requireCaller } from "./caller.ts";
import type { FirstBindingStore, QuestionAsker, SessionProject } from "./first-binding.ts";
import { resolveSessionProject } from "./first-binding.ts";

/** The six model-facing names, in contract order (lines 110-316). */
export const DECISION_TOOL_NAMES = [
  "decision_search",
  "decision_get",
  "decision_create",
  "decision_create_batch",
  "decision_update",
  "decision_void",
] as const;

export type DecisionToolName = (typeof DECISION_TOOL_NAMES)[number];

/**
 * Author-facing schema node, in the shape the DSH tool registry compiles.
 *
 * Mirrors `@deepseek-ai/dsh-tools` defineTool: parameters are a property map whose
 * entries carry their own `required`, and output.schema is a value node. Types here
 * are structural so this module builds and tests without the Host installed.
 */
export interface SchemaNode {
  readonly type?: "string" | "integer" | "number" | "boolean" | "null" | "array" | "object" | "json";
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly const?: string | boolean;
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: boolean;
  readonly oneOf?: readonly SchemaNode[];
}

export interface ToolTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ToolOutputSpec {
  readonly schema: SchemaNode;
  readonly render: (args: unknown, value: unknown) => ToolTextBlock[];
}

/** Execution context the Host passes to a tool body. */
export interface ToolExecution {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: unknown;
  readonly signal?: unknown;
}

/** A registry-ready tool definition (the subset of defineTool's result used here). */
export interface ToolDefinition {
  readonly name: DecisionToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, SchemaNode>>;
  readonly output: ToolOutputSpec;
  readonly execute: (args: unknown, exec: ToolExecution) => Promise<unknown>;
}

/**
 * Refusal raised when the Host cannot trust the caller.
 *
 * Deliberately an Error rather than a domain envelope: the seven contract codes do
 * not cover caller identity, and inventing an eighth would let a Client read an
 * authorization failure as a business answer. Carrying `reason` keeps the
 * PLAN-0778 vocabulary (CALLER_REQUIRED / CALLER_NOT_LIVE / DELEGATED_CALLER) and
 * makes every tool's refusal identical for the same cause.
 */
export class DecisionToolRefusal extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "DecisionToolRefusal";
    this.reason = reason;
  }
}

/** Store surface the six tools need (PLAN-0777 methods, zero new SQL). */
export interface DecisionToolStore extends FirstBindingStore {
  searchDecisions(projectId: number, input: unknown): DomainResult<DecisionSearchPage>;
  getDecision(projectId: number, input: unknown): DomainResult<DecisionRecord>;
  getDecisionHistory(projectId: number, decisionId: number): DomainResult<DecisionRevisionRecord[]>;
  createDecision(projectId: number, input: unknown): DomainResult<DecisionCreateReceipt>;
  createDecisionsBatch(projectId: number, input: unknown): DomainResult<DecisionBatchReceipt>;
  updateDecision(projectId: number, input: unknown): DomainResult<DecisionUpdateReceipt>;
  voidDecision(projectId: number, input: unknown): DomainResult<DecisionVoidReceipt>;
}

export interface DecisionToolDeps {
  readonly agents: LiveAgentRegistry;
  readonly openStore: () => DecisionToolStore;
  readonly asker: QuestionAsker;
  /** Optional foreground timeout for the first-use project question. */
  readonly projectTimeoutMs?: number;
}

export interface ToolSuccess {
  readonly ok: true;
  readonly data: unknown;
}

/** The envelope every tool returns on a domain failure (line 108). */
export interface ToolFailure {
  readonly ok: false;
  readonly error: DomainErrorBody;
}

/** Pass a domain failure through as the tool's envelope; unwrap a success. */
function envelope<T>(result: DomainResult<T>): ToolSuccess | ToolFailure {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

/** Carrier so a domain failure from the outlet reaches the tool's envelope. */
class DomainEnvelopeError extends Error {
  readonly body: DomainErrorBody;

  constructor(body: DomainErrorBody) {
    super(body.message);
    this.name = "DomainEnvelopeError";
    this.body = body;
  }
}

/**
 * Refuse a caller before any store or question access.
 *
 * Split out so all six tools share one refusal path: the gate runs once, its three
 * reasons throw the same error type with the same fields, and no tool can
 * accidentally continue past it.
 */
function assertCaller(agent: unknown, deps: DecisionToolDeps): CallerSession {
  const decision = requireCaller(agent, deps.agents);
  if (!decision.ok) throw new DecisionToolRefusal(decision.reason, decision.message);
  return decision.caller;
}

/**
 * Resolve the session project through the single PLAN-0778 outlet.
 *
 * A project-selection refusal (cancelled, timed out, or no selection) becomes the
 * contract's PROJECT_REQUIRED envelope (line 348); a caller refusal stays a thrown
 * DecisionToolRefusal, because identity is not a business outcome.
 */
async function projectFor(caller: CallerSession, deps: DecisionToolDeps): Promise<SessionProject> {
  const outcome = await resolveSessionProject(
    caller.agent,
    { agents: deps.agents, openStore: deps.openStore, asker: deps.asker },
    deps.projectTimeoutMs === undefined
      ? {}
      : { timeoutMs: deps.projectTimeoutMs, callId: "dsd-project-choice" },
  );
  if (outcome.ok) return outcome.project;
  if ("error" in outcome) throw new DomainEnvelopeError(outcome.error);
  throw new DomainEnvelopeError({ code: "PROJECT_REQUIRED", message: outcome.message });
}

/**
 * Run one tool body after the caller gate and the project outlet.
 *
 * The store is opened only after both succeed, so a refused caller performs zero
 * data access (PLAN-0778 T1.2). Domain failures become envelopes; refusals and
 * unexpected errors propagate.
 */
async function runTool(
  agent: unknown,
  deps: DecisionToolDeps,
  body: (project: SessionProject, store: DecisionToolStore, caller: CallerSession) => unknown,
): Promise<unknown> {
  const caller = assertCaller(agent, deps);
  try {
    const project = await projectFor(caller, deps);
    const store = deps.openStore();
    return await body(project, store, caller);
  } catch (error) {
    if (error instanceof DomainEnvelopeError) return { ok: false, error: error.body };
    throw error;
  }
}

/** Human-readable text for one tool result, shared by all six renders. */
function summaryText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "Decision tool finished.";
  const result = value as { ok?: unknown; data?: unknown; error?: unknown };
  if (result.ok === true) return "OK: " + JSON.stringify(result.data);
  if (result.ok === false) {
    const body = result.error as DomainErrorBody | undefined;
    return "Failed: " + (body?.code ?? "ERROR") + " — " + (body?.message ?? "no detail");
  }
  return "Decision tool finished.";
}

function outputOf(schema: SchemaNode): ToolOutputSpec {
  return { schema, render: (_args, value) => [{ type: "text", text: summaryText(value) }] };
}


// ---------------------------------------------------------------------------
// Schema builders
//
// Author-facing nodes in the shape the DSH registry compiles. String lengths,
// ASCII key rules, calendar dates and cross-field state constraints stay in the
// domain parser: JSON Schema cannot express code-point counts (contract line 88:
// the Host validates what the schema cannot). Nullability is a oneOf of the value
// and null, because null is a value and "" is not (line 92).
// ---------------------------------------------------------------------------

const STRING: SchemaNode = { type: "string" };
const INTEGER: SchemaNode = { type: "integer" };
const NULLABLE: SchemaNode = { oneOf: [STRING, { type: "null" }] };
const HORIZON = ["long_term", "temporary"] as const;
const STATUS = ["effective", "voided"] as const;

function prop(node: SchemaNode, required: boolean, description: string): SchemaNode {
  return { ...node, ...(required ? { required: true } : {}), description };
}

function objectNode(properties: Record<string, SchemaNode>): SchemaNode {
  return { type: "object", additionalProperties: false, properties };
}

/**
 * The declared result schema for one tool.
 *
 * The envelope is `{ok:true,data}` or `{ok:false,error}` (contract line 108). The
 * enforced schema subset cannot state "data present iff ok", so the declaration
 * is the honest common superset — `ok` required, `data` and `error` declared with
 * their own shapes — and the two-branch invariant is asserted on real results in
 * the tests instead of being claimed by a schema that cannot enforce it.
 */
function resultSchema(data: SchemaNode): SchemaNode {
  return objectNode({
    ok: prop({ type: "boolean" }, true, "true on success, false on a domain failure."),
    data: prop(data, false, "Present when ok is true."),
    error: prop(
      objectNode({
        code: prop(
          {
            type: "string",
            enum: [
              "VALIDATION_FAILED",
              "PROJECT_REQUIRED",
              "DECISION_NOT_FOUND",
              "REVISION_CONFLICT",
              "DECISION_NOT_EDITABLE",
              "DATABASE_BUSY",
              "DATABASE_ERROR",
            ],
          },
          true,
          "One of the seven contract error codes (contract line 348-353).",
        ),
        message: prop(STRING, true, "Human-readable message; never contains decision, rationale or source text."),
        field: prop(STRING, false, "The offending input field, when attributable."),
        itemIndex: prop(INTEGER, false, "1-based batch item index, when attributable (contract line 346)."),
      }),
      false,
      "Present when ok is false.",
    ),
  });
}

/** Shared decision-field parameters (contract lines 94-102). */
function sharedDecisionParameters(): Record<string, SchemaNode> {
  return {
    summary: prop(NULLABLE, false, "1–300 code points; null or omitted means no summary; an empty string is rejected."),
    decision: prop(STRING, true, "1–20,000 code points of plain multi-line text; must not be blank."),
    rationale: prop(NULLABLE, false, "Up to 20,000 code points; null or omitted means none."),
    timeHorizon: prop({ type: "string", enum: [...HORIZON] }, false, "long_term or temporary; omitted defaults to temporary."),
    decisionDate: prop(NULLABLE, false, "Calendar date YYYY-MM-DD, or null."),
    reviewDate: prop(NULLABLE, false, "Calendar date YYYY-MM-DD, or null; never triggers a status change."),
    sourceReference: prop(NULLABLE, false, "Up to 4,000 code points of plain text; never an identity or id mapping."),
  };
}

/** Complete record returned by decision_get (contract lines 155-177). */
const DECISION_RECORD: SchemaNode = objectNode({
  decisionId: prop(INTEGER, true, "DSD number, assigned inside this Profile database."),
  revision: prop(INTEGER, true, "Current revision; pass it as expectedRevision for update/void."),
  summary: prop(NULLABLE, true, "Short summary, or null."),
  decision: prop(STRING, true, "The decision text."),
  rationale: prop(NULLABLE, true, "Reasoning, or null."),
  timeHorizon: prop({ type: "string", enum: [...HORIZON] }, true, "long_term or temporary."),
  decisionDate: prop(NULLABLE, true, "Calendar date, or null."),
  reviewDate: prop(NULLABLE, true, "Calendar date, or null."),
  status: prop({ type: "string", enum: [...STATUS] }, true, "effective or voided."),
  voidReason: prop(NULLABLE, true, "Void reason when voided, otherwise null."),
  voidedAt: prop(NULLABLE, true, "Void timestamp when voided, otherwise null."),
  sourceReference: prop(NULLABLE, true, "Source text, or null."),
  createdAt: prop(STRING, true, "Creation timestamp."),
  updatedAt: prop(STRING, true, "Last update timestamp."),
});

// ---------------------------------------------------------------------------
// The six tool definitions
//
// Each description carries the intent trust boundary the contract assigns to it
// (line 88: the write tools' descriptions, not a per-operation UI confirmation),
// and each body delegates to the shared gate + outlet + store.
// ---------------------------------------------------------------------------

/** decision_search (contract lines 110-143). */
const SEARCH_DESCRIPTION =
"Find decisions in the current session's project by keyword. Returns compact hits only; call decision_get with the DSD number for full content. Matching is a literal substring: ASCII letters are case-insensitive, non-ASCII matches by code point, and % or _ are not wildcards.";

const SEARCH_PARAMETERS: Record<string, SchemaNode> = {
  query: prop(STRING, true, "1–500 code points, not blank. Searches summary, decision, rationale and source reference."),
  includeVoided: prop({ type: "boolean" }, false, "Include voided decisions; default false."),
  limit: prop(INTEGER, false, "Page size 1–20; default 10."),
  offset: prop(INTEGER, false, "Non-negative safe integer; default 0. Increase it to page."),
};

/** decision_get (contract lines 145-177). */
const GET_DESCRIPTION =
"Read one complete decision, including its current status and revision, from the current session's project by DSD number. Voided decisions remain readable. A decision that does not exist here is reported the same way as one that belongs elsewhere.";

const GET_PARAMETERS: Record<string, SchemaNode> = {
  decisionId: prop(INTEGER, true, "Positive integer DSD number shown in search results."),
};

/** decision_create (contract lines 179-210). */
const CREATE_DESCRIPTION =
"Save one decision in the current session's project, only when the user explicitly asked for it. The required field is the decision content itself — do not invent a title. Fill summary only when a short summary genuinely helps. Never pass a source number or project number; use the returned DSD number afterwards.";

const CREATE_PARAMETERS = sharedDecisionParameters();

/** decision_create_batch (contract lines 212-256). */
const CREATE_BATCH_DESCRIPTION =
"Save several decisions you have already organised, only when the user explicitly asked for them, each with the same fields as decision_create. One successful call commits the whole batch; any validation or write failure leaves nothing behind. Do not use a repeated call as a safe retry.";

const CREATE_BATCH_PARAMETERS: Record<string, SchemaNode> = {
  decisions: prop(
    { type: "array", items: { type: "object", additionalProperties: false, properties: sharedDecisionParameters() } },
    true,
    "1–100 decisions. Any failure rolls the whole batch back and returns no new numbers.",
  ),
};

/** decision_update (contract lines 258-290). */
const UPDATE_DESCRIPTION =
"Edit an existing decision in the current session's project after the user explicitly asks for it. First call decision_get to read the present revision, then pass that value unchanged as expectedRevision. Send only the fields you actually change; omitted fields stay as they are. On REVISION_CONFLICT, re-read and let the user decide — never merge or replay an old patch automatically. Project, number, revision and status cannot be changed.";

const UPDATE_PARAMETERS: Record<string, SchemaNode> = {
  decisionId: prop(INTEGER, true, "Positive integer DSD number of the decision to edit."),
  expectedRevision: prop(INTEGER, true, "The revision you just read; a stale value is refused without any side effect."),
  patch: prop(
    {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: prop(NULLABLE, false, "New summary, or null to clear it. An empty string is not a clear."),
        decision: prop(STRING, false, "New decision text; null is not accepted."),
        rationale: prop(NULLABLE, false, "New rationale, or null to clear it."),
        timeHorizon: prop({ type: "string", enum: [...HORIZON] }, false, "long_term or temporary; null is not accepted."),
        decisionDate: prop(NULLABLE, false, "New calendar date, or null to clear it."),
        reviewDate: prop(NULLABLE, false, "New calendar date, or null to clear it."),
        sourceReference: prop(NULLABLE, false, "New source text, or null to clear it."),
      },
    },
    true,
    "At least one field. Clearing a field requires null; an empty string is rejected.",
  ),
};

/** decision_void (contract lines 292-316). */
const VOID_DESCRIPTION =
"Void a decision in the current session's project after the user explicitly asks for it. First call decision_get to read the present revision, then pass that value unchanged as expectedRevision. Voiding keeps the record and its history and requires a reason. On REVISION_CONFLICT, re-read and let the user decide; on an unknown outcome, verify by reading and never replay automatically. This tool performs no physical deletion and cannot restore a voided decision.";

const VOID_PARAMETERS: Record<string, SchemaNode> = {
  decisionId: prop(INTEGER, true, "Positive integer DSD number of the decision to void."),
  expectedRevision: prop(INTEGER, true, "The revision you just read; a stale value is refused without any side effect."),
  reason: prop(STRING, true, "1–1,000 code points; blank after trimming is rejected; stored exactly as given."),
};

/** Decision_search result (contract lines 127-141). */
const SEARCH_DATA: SchemaNode = objectNode({
  decisions: prop(
    {
      type: "array",
      items: objectNode({
        decisionId: prop(INTEGER, true, "DSD number."),
        preview: prop(STRING, true, "Up to 240 code points."),
        status: prop({ type: "string", enum: [...STATUS] }, true, "effective or voided."),
      }),
    },
    true,
    "Compact hits; empty when nothing matched.",
  ),
  hasMore: prop({ type: "boolean" }, true, "true when another page exists; increase offset."),
});

const CREATE_DATA: SchemaNode = objectNode({
  decisionId: prop(INTEGER, true, "The new DSD number."),
  revision: prop(INTEGER, true, "Always 1 for a new record."),
  summary: prop(NULLABLE, true, "The stored summary, or null."),
  status: prop({ type: "string", enum: ["effective"] }, true, "New records are effective."),
  createdAt: prop(STRING, true, "Creation timestamp."),
});

const CREATE_BATCH_DATA: SchemaNode = objectNode({
  createdCount: prop(INTEGER, true, "Number of records created by this call."),
  decisions: prop(
    {
      type: "array",
      items: objectNode({
        index: prop(INTEGER, true, "1-based position in the submitted batch."),
        decisionId: prop(INTEGER, true, "New DSD number."),
        revision: prop(INTEGER, true, "Always 1 for a new record."),
      }),
    },
    true,
    "One entry per created record.",
  ),
});

const UPDATE_DATA: SchemaNode = objectNode({
  decisionId: prop(INTEGER, true, "DSD number."),
  revision: prop(INTEGER, true, "The revision after this update."),
  changedFields: prop({ type: "array", items: STRING }, true, "Fields this call actually changed."),
  status: prop({ type: "string", enum: ["effective"] }, true, "An update keeps the record effective."),
  updatedAt: prop(STRING, true, "New timestamp."),
});

const VOID_DATA: SchemaNode = objectNode({
  decisionId: prop(INTEGER, true, "DSD number."),
  revision: prop(INTEGER, true, "The revision after this void."),
  status: prop({ type: "string", enum: ["voided"] }, true, "Voided records stay readable."),
  voidedAt: prop(STRING, true, "Void timestamp."),
});

// ---------------------------------------------------------------------------
// Tool factories
//
// One factory per tool keeps each body's contract anchor visible. All six share
// assertCaller -> projectFor -> openStore, so no tool can bypass the gate or
// resolve its own binding (ruling D1).
// ---------------------------------------------------------------------------

export function createSearchTool(deps: DecisionToolDeps): ToolDefinition {
  return {
    name: "decision_search",
    description: SEARCH_DESCRIPTION,
    parameters: SEARCH_PARAMETERS,
    output: outputOf(resultSchema(SEARCH_DATA)),
    execute: (args, exec) =>
      runTool(exec.agent, deps, (project, store) => envelope(store.searchDecisions(project.projectId, args))),
  };
}

export function createGetTool(deps: DecisionToolDeps): ToolDefinition {
  return {
    name: "decision_get",
    description: GET_DESCRIPTION,
    parameters: GET_PARAMETERS,
    output: outputOf(resultSchema(DECISION_RECORD)),
    execute: (args, exec) =>
      runTool(exec.agent, deps, (project, store) => envelope(store.getDecision(project.projectId, args))),
  };
}

export function createCreateTool(deps: DecisionToolDeps): ToolDefinition {
  return {
    name: "decision_create",
    description: CREATE_DESCRIPTION,
    parameters: CREATE_PARAMETERS,
    output: outputOf(resultSchema(CREATE_DATA)),
    execute: (args, exec) =>
      runTool(exec.agent, deps, (project, store) => envelope(store.createDecision(project.projectId, args))),
  };
}

export function createCreateBatchTool(deps: DecisionToolDeps): ToolDefinition {
  return {
    name: "decision_create_batch",
    description: CREATE_BATCH_DESCRIPTION,
    parameters: CREATE_BATCH_PARAMETERS,
    output: outputOf(resultSchema(CREATE_BATCH_DATA)),
    execute: (args, exec) =>
      runTool(exec.agent, deps, (project, store) => envelope(store.createDecisionsBatch(project.projectId, args))),
  };
}

export function createUpdateTool(deps: DecisionToolDeps): ToolDefinition {
  return {
    name: "decision_update",
    description: UPDATE_DESCRIPTION,
    parameters: UPDATE_PARAMETERS,
    output: outputOf(resultSchema(UPDATE_DATA)),
    execute: (args, exec) =>
      runTool(exec.agent, deps, (project, store) => envelope(store.updateDecision(project.projectId, args))),
  };
}

export function createVoidTool(deps: DecisionToolDeps): ToolDefinition {
  return {
    name: "decision_void",
    description: VOID_DESCRIPTION,
    parameters: VOID_PARAMETERS,
    output: outputOf(resultSchema(VOID_DATA)),
    execute: (args, exec) =>
      runTool(exec.agent, deps, (project, store) => envelope(store.voidDecision(project.projectId, args))),
  };
}

/**
 * The six definitions in contract order.
 *
 * A single factory that builds all six through the same deps is what makes the
 * "one outlet, six tools" property structural: the wiring face registers this
 * array and cannot hand a tool different dependencies.
 */
export function createDecisionTools(deps: DecisionToolDeps): ToolDefinition[] {
  return [
    createSearchTool(deps),
    createGetTool(deps),
    createCreateTool(deps),
    createCreateBatchTool(deps),
    createUpdateTool(deps),
    createVoidTool(deps),
  ];
}

/** Register all six tools on a registry-shaped sink (the Host's ctx.tools). */
export function registerDecisionTools(
  sink: { register(definition: unknown): unknown },
  deps: DecisionToolDeps,
): void {
  for (const tool of createDecisionTools(deps)) sink.register(tool);
}
