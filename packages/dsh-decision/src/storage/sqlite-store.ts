import { DatabaseSync } from "node:sqlite";
import { isAbsolute, parse } from "node:path";
import {
  parseDecisionCreateBatchInput,
  parseDecisionCreateInput,
  parseDecisionGetInput,
  parseDecisionSearchInput,
  parseDecisionUpdateInput,
  parseDecisionVoidInput,
  parseProjectInput,
  parseProjectKey,
} from "../domain/decision-contract.ts";
import type {
  DecisionCreateInput,
  DecisionGetInput,
  DecisionRecord,
  DecisionSearchInput,
  DecisionStatus,
  DecisionUpdateInput,
  DecisionVoidInput,
  DomainErrorCode,
  DomainResult,
  ProjectInput,
  TimeHorizon,
} from "../domain/decision-contract.ts";

// task-377 (requirements §10.2/§10.3/§10.4/§10.5, current four items): schema v2
// adds the external idempotency key (external_id), typed reference edges
// (decision_refs), and the replaces declaration (replaces_json). v1 databases
// migrate in place; every stored v1 row keeps its exact values (the new columns
// start NULL). The time_horizon column default for fresh databases becomes
// long_term; migrated v1 databases keep their old column default, which the
// store never reads because every insert passes time_horizon explicitly.
// task-615 (609 G3): schema v3 adds decision_replaces, the reverse index for
// "which decisions declare that they replace X". It is a DERIVED projection of
// decisions.replaces_json (the declaration stays the single authority; see
// docs/replaces-reverse-lookup-design.md §3). v1 and v2 databases migrate in
// place; a migration failure aborts the open instead of degrading.
const SCHEMA_VERSION = 3;
const UNICODE_WHITE_SPACE_SQL = "char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288)";

export interface SQLiteDecisionStoreOptions {
  databasePath: string;
}

export interface ProjectRecord {
  projectId: number;
  name: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBindingRecord extends ProjectRecord {
  sessionId: string;
}

/** The ref types a decision may carry (requirements §10.3 direction rule).
 * 'bl' is deliberately absent: a decision must not reference a backlog item;
 * only bl records may reference decisions. The decision_refs CHECK enforces
 * this structurally, so a reversed edge is rejected at write time. */
export const DECISION_REF_TYPES = ["decision", "task", "plan", "commit"] as const;
export type DecisionRefType = (typeof DECISION_REF_TYPES)[number];

export interface DecisionRef {
  type: DecisionRefType;
  id: string;
}

/** A decision record as returned by getDecision, extended with the task-377
 * fields. The base shape stays the frozen domain DecisionRecord (revision
 * snapshots keep exactly that shape). */
export interface DecisionRecordView extends DecisionRecord {
  externalId: string | null;
  replaces: number[] | null;
  /** task-393: the decision's typed references in insertion order, [] when
   * none. Reading them answers "does this decision have a downstream task"
   * (requirements §11 item 3) without a seventh tool. */
  refs: DecisionRef[];
}

export interface DecisionSearchItem {
  decisionId: number;
  preview: string;
  status: DecisionStatus;
  /** task-377 ④: lets callers separate temporary from long-term decisions. */
  timeHorizon: TimeHorizon;
  /** task-406 自用验证：命中项直接带外部键（台账 D 号），无需逐条 get 回查；
   * 未设 externalId 的决策为 null。只增字段，不改既有字段语义。 */
  externalId: string | null;
  /** task-615 (609 G3): the declaration this record carries ("I replace these"),
   * read from the AUTHORITY (replaces_json), not from the projection. null when
   * the record declares nothing. */
  replaces: number[] | null;
  /** task-1 (原 task-624): present only when the caller passed withRefTypes:true.
   * The KINDS of edges this hit has, de-duplicated and in the canonical
   * DECISION_REF_TYPES order — never the ids. Enough to tell, on the same page,
   * whether a dispatch-gap hit carries anything at all and of which kinds, so a
   * triage does not fall back to 1+N decision_get calls; the ids stay on
   * decision_get (the summary answers "which kinds", not "which targets"). */
  refTypes?: DecisionRefType[];
}

export interface DecisionSearchPage {
  decisions: DecisionSearchItem[];
  hasMore: boolean;
}

export interface DecisionCreateReceipt {
  decisionId: number;
  /** 1 for a new record; the existing record's revision when deduplicated. */
  revision: number;
  summary: string | null;
  /** "effective" for a new record; the existing record's status when deduplicated. */
  status: DecisionStatus;
  createdAt: string;
  /** Present only when the input carried externalId. */
  externalId?: string;
  /** Present only when the input carried externalId: true means an existing
   * record was returned instead of creating a duplicate (requirements §10.2). */
  alreadyExisted?: boolean;
  /** task-600 ③: present only when the deduplicated record lives in a DIFFERENT
   * project of this Profile database. Its presence is the whole point: the
   * external key is a workspace-wide work-item number, so a caller in project B
   * may own nothing, and the returned decisionId is NOT readable from B. Without
   * this field the receipt looked like a plain success. */
  existingProjectId?: number;
}

export interface DecisionBatchReceipt {
  /** Number of records newly inserted by this call; rows returned as
   * already-existed (external_id dedupe) are not counted. */
  createdCount: number;
  decisions: Array<{
    index: number;
    decisionId: number;
    /** 1 for a new record; the existing record's revision when deduplicated. */
    revision: number;
    externalId?: string;
    alreadyExisted?: boolean;
    /** task-600 ③: see DecisionCreateReceipt.existingProjectId. */
    existingProjectId?: number;
  }>;
}

export interface DecisionUpdateReceipt {
  decisionId: number;
  revision: number;
  changedFields: string[];
  status: "effective";
  updatedAt: string;
}

export interface DecisionVoidReceipt {
  decisionId: number;
  revision: number;
  status: "voided";
  voidedAt: string;
}

export interface DecisionRevisionRecord {
  revisionId: number;
  decisionId: number;
  changeKind: "update" | "void";
  snapshot: DecisionRecord;
  createdAt: string;
}

interface ProjectRow {
  projectId: number;
  name: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
}

interface DecisionRow {
  decisionId: number;
  revision: number;
  projectId: number;
  decision: string;
  summary: string | null;
  rationale: string | null;
  timeHorizon: TimeHorizon;
  decisionDate: string | null;
  reviewDate: string | null;
  status: DecisionStatus;
  voidReason: string | null;
  voidedAt: string | null;
  sourceReference: string | null;
  createdAt: string;
  updatedAt: string;
  externalId: string | null;
  replacesJson: string | null;
}

/** Identity fields of an existing decision, used to answer an external_id
 * dedupe hit without re-reading the row. */
interface ExistingDecisionTarget {
  decisionId: number;
  revision: number;
  summary: string | null;
  status: DecisionStatus;
  createdAt: string;
  /** task-600 ③: owner project, so a cross-project hit can say so. */
  projectId: number;
}

interface RevisionRow {
  revisionId: number;
  decisionId: number;
  changeKind: "update" | "void";
  snapshotJson: string;
  createdAt: string;
}

type Statement = ReturnType<DatabaseSync["prepare"]>;
type BindValue = string | number | bigint | null;

// Node v24.21.0 has no StatementSync.close()/Symbol.dispose(); prepared statements
// stay cached for this connection and DatabaseSync.close() owns connection teardown.
const statementCache = new WeakMap<DatabaseSync, Map<string, Statement>>();

function failure<T>(code: DomainErrorCode, message: string, field?: string, itemIndex?: number): DomainResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(field === undefined ? {} : { field }),
      ...(itemIndex === undefined ? {} : { itemIndex }),
    },
  };
}

function validationFailure<T>(field: string, message: string): DomainResult<T> {
  return failure("VALIDATION_FAILED", message, field);
}

function parserFailure<T>(result: DomainResult<unknown>): DomainResult<T> {
  if (result.ok) throw new TypeError("Expected a failed domain parse result.");
  return { ok: false, error: result.error };
}

function parsePositiveSafeInteger(value: unknown, field: string): DomainResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return validationFailure(field, "Expected a positive safe integer.");
  }
  return { ok: true, data: value };
}

function validateSessionId(value: unknown): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return validationFailure("sessionId", "Expected a non-empty session identifier.");
  }
  return { ok: true, data: value };
}

// ---------------------------------------------------------------------------
// task-377 input extensions.
//
// The domain parser (src/domain/decision-contract.ts) is a frozen contract and
// rejects undeclared fields, so the new create fields (externalId, refs,
// replaces) are split out HERE, validated with the same discipline (no coercion,
// unknown fields rejected), and only the remaining base object is handed to the
// frozen parser. The domain file is not modified; without the new fields every
// call takes exactly the old path.
// ---------------------------------------------------------------------------

const CREATE_EXTENSION_FIELDS = new Set(["externalId", "refs", "replaces"]);

/** The contract's White_Space set, identical to UNICODE_WHITE_SPACE_SQL above. */
const CONTRACT_WHITE_SPACE = /[\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnProperty(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function isBlankContract(value: string): boolean {
  return Array.from(value).every((char) => CONTRACT_WHITE_SPACE.test(char));
}

/** task-600 ①: whitespace at either end is rejected, never trimmed. Trimming
 * would silently fold two different inputs into one identity, and the key is
 * supposed to be an exact work-item number (D-1120 / BL-584). */
function startsOrEndsWithContractWhitespace(value: string): boolean {
  const chars = Array.from(value);
  return CONTRACT_WHITE_SPACE.test(chars[0]!) || CONTRACT_WHITE_SPACE.test(chars[chars.length - 1]!);
}

function parseExternalId(value: unknown): DomainResult<string> {
  if (typeof value !== "string") {
    return validationFailure("externalId", "Expected a string of 1–200 code points; omit the field instead of passing null.");
  }
  if (value.includes("\u0000")) return validationFailure("externalId", "NUL is not allowed.");
  const length = Array.from(value).length;
  if (length < 1 || length > 200) return validationFailure("externalId", "Expected 1–200 Unicode code points.");
  if (isBlankContract(value)) return validationFailure("externalId", "Must not be blank.");
  if (startsOrEndsWithContractWhitespace(value)) {
    return validationFailure(
      "externalId",
      "Must not begin or end with whitespace; the key is stored exactly as given (no trimming, no case folding, no zero padding).",
    );
  }
  return { ok: true, data: value };
}

function parseRefs(value: unknown): DomainResult<DecisionRef[]> {
  if (!Array.isArray(value)) {
    return validationFailure("refs", "Expected an array of {type, id} objects; omit the field instead of passing null.");
  }
  const refs: DecisionRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isPlainRecord(item)) {
      return validationFailure("refs", "Each ref must be an object with exactly type and id.");
    }
    const extra = Object.keys(item).find((key) => key !== "type" && key !== "id");
    if (extra !== undefined) return validationFailure("refs", "Unknown field in a ref entry.");
    if (typeof item.type !== "string" || !(DECISION_REF_TYPES as readonly string[]).includes(item.type)) {
      // The direction rule (requirements §10.3): decision -> bl is the reversed
      // edge the requirement wants rejected at write time, not discovered later.
      return validationFailure("refs", "Expected ref type decision, task, plan or commit; a decision must not reference bl (direction rule).");
    }
    if (typeof item.id !== "string") {
      return validationFailure("refs", "Expected ref id to be a string of 1–200 code points.");
    }
    if (item.id.includes("\u0000")) return validationFailure("refs", "NUL is not allowed.");
    const idLength = Array.from(item.id).length;
    if (idLength < 1 || idLength > 200) {
      return validationFailure("refs", "Expected ref id of 1–200 Unicode code points.");
    }
    if (isBlankContract(item.id)) return validationFailure("refs", "Ref id must not be blank.");
    const edge = `${item.type}\u0000${item.id}`;
    if (seen.has(edge)) return validationFailure("refs", "Duplicate ref in the list.");
    seen.add(edge);
    refs.push({ type: item.type as DecisionRefType, id: item.id });
  }
  return { ok: true, data: refs };
}

function parseReplacesInput(value: unknown): DomainResult<number[]> {
  if (!Array.isArray(value)) {
    return validationFailure("replaces", "Expected an array of decision numbers; omit the field instead of passing null.");
  }
  if (value.length < 1 || value.length > 100) {
    return validationFailure("replaces", "Expected 1–100 decision numbers.");
  }
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      return validationFailure("replaces", "Expected positive integer decision numbers.");
    }
    if (seen.has(entry)) return validationFailure("replaces", "Duplicate decision number in the list.");
    seen.add(entry);
    ids.push(entry);
  }
  return { ok: true, data: ids };
}

interface CreateExtensionSplit {
  /** The input minus the extension fields, for the frozen domain parser. */
  base: unknown;
  externalId?: string;
  refs?: DecisionRef[];
  replaces?: number[];
  /** True when the raw input omitted timeHorizon: the store default (long_term)
   * applies. Kept as a defensive split even after task-46 aligned the parser's
   * default to long_term — the raw input can still omit the field, and this flag
   * is what lets the store ignore a parser-filled value. (The earlier comment here
   * cited requirements §10.5 as the source of long_term; §10.5 only defers the
   * field name/values to PLAN-0769 and specifies no default — corrected 2026-11-16.) */
  timeHorizonOmitted: boolean;
}

function parseCreateExtensions(input: unknown): DomainResult<CreateExtensionSplit> {
  if (!isPlainRecord(input)) {
    // Not an object: let the frozen parser produce the canonical error.
    return { ok: true, data: { base: input, timeHorizonOmitted: false } };
  }
  const record = input;
  let externalId: string | undefined;
  if (hasOwnProperty(record, "externalId")) {
    const parsed = parseExternalId(record.externalId);
    if (!parsed.ok) return parsed;
    externalId = parsed.data;
  }
  let refs: DecisionRef[] | undefined;
  if (hasOwnProperty(record, "refs")) {
    const parsed = parseRefs(record.refs);
    if (!parsed.ok) return parsed;
    refs = parsed.data;
  }
  let replaces: number[] | undefined;
  if (hasOwnProperty(record, "replaces")) {
    const parsed = parseReplacesInput(record.replaces);
    if (!parsed.ok) return parsed;
    replaces = parsed.data;
  }
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CREATE_EXTENSION_FIELDS.has(key)) base[key] = value;
  }
  return {
    ok: true,
    data: {
      base,
      ...(externalId === undefined ? {} : { externalId }),
      ...(refs === undefined ? {} : { refs }),
      ...(replaces === undefined ? {} : { replaces }),
      timeHorizonOmitted: !hasOwnProperty(record, "timeHorizon") || record.timeHorizon === undefined,
    },
  };
}

interface BatchExtensionSplit {
  base: unknown;
  items: CreateExtensionSplit[];
}

function splitBatchInput(input: unknown): DomainResult<BatchExtensionSplit> {
  if (!isPlainRecord(input) || !Array.isArray(input.decisions)
    || input.decisions.length < 1 || input.decisions.length > 100) {
    // Outer shape is invalid: let the frozen parser produce the canonical error
    // (field "decisions" / "input", without row coordinates).
    return { ok: true, data: { base: input, items: [] } };
  }
  const raw = input.decisions;
  const bases: unknown[] = [];
  const items: CreateExtensionSplit[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const split = parseCreateExtensions(raw[index]);
    if (!split.ok) return { ok: false, error: { ...split.error, itemIndex: index + 1 } };
    bases.push(split.data.base);
    items.push(split.data);
  }
  return { ok: true, data: { base: { ...input, decisions: bases }, items } };
}

/** The decision fields plus the task-377 extensions, ready for insert. */
interface DecisionInsertItem extends DecisionCreateInput {
  externalId?: string;
  refs?: DecisionRef[];
  replaces?: number[];
}

function buildInsertItem(parsed: DecisionCreateInput, split: CreateExtensionSplit): DecisionInsertItem {
  const item: DecisionInsertItem = {
    ...parsed,
    timeHorizon: split.timeHorizonOmitted ? "long_term" : parsed.timeHorizon,
  };
  if (split.externalId !== undefined) item.externalId = split.externalId;
  if (split.refs !== undefined) item.refs = split.refs;
  if (split.replaces !== undefined) item.replaces = split.replaces;
  return item;
}

// ---------------------------------------------------------------------------
// task-405 update extension (D-1245②).
//
// refs evolve from create-time immutable to ADD-ONLY: XH rules first and
// dispatches cards later, so a decision's task/plan edges are often known only
// after creation. patch.refs APPENDS edges — existing edges are kept, duplicate
// edges are ignored, and no input shape can remove an edge. Same discipline as
// create: the field is split out before the frozen parser, which never sees it.
// ---------------------------------------------------------------------------

function splitUpdateInput(rawInput: unknown): DomainResult<{ base: unknown; refs?: DecisionRef[] }> {
  if (!isPlainRecord(rawInput)) return { ok: true, data: { base: rawInput } };
  if (!hasOwnProperty(rawInput, "patch") || !isPlainRecord(rawInput.patch)) {
    return { ok: true, data: { base: rawInput } };
  }
  const patch = rawInput.patch;
  if (!hasOwnProperty(patch, "refs")) return { ok: true, data: { base: rawInput } };
  const parsed = parseRefs(patch.refs);
  if (!parsed.ok) return parsed;
  // Append needs at least one edge: an empty list is rejected, never applied,
  // so no input shape can be read as "clear the references" (add-only, D-1245②).
  if (parsed.data.length === 0) {
    return validationFailure("refs", "Expected 1–100 refs to append; omit the field instead of passing an empty list.");
  }
  const basePatch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field !== "refs") basePatch[field] = value;
  }
  return { ok: true, data: { base: { ...rawInput, patch: basePatch }, refs: parsed.data } };
}

/**
 * Envelope validation for a refs-only append.
 *
 * The frozen update parser requires at least one CONTENT field, so a patch
 * carrying only refs cannot go through it. The envelope is validated here with
 * the same rules and messages (unknown top-level fields rejected; decisionId
 * and expectedRevision positive safe integers); the content patch stays empty.
 */
function parseRefsOnlyUpdateEnvelope(base: Record<string, unknown>): DomainResult<DecisionUpdateInput> {
  const extra = Object.keys(base).find(
    (field) => field !== "decisionId" && field !== "expectedRevision" && field !== "patch",
  );
  if (extra !== undefined) return validationFailure(extra, "Unknown field.");
  const decisionId = parsePositiveSafeInteger(base.decisionId, "decisionId");
  if (!decisionId.ok) return decisionId;
  const expectedRevision = parsePositiveSafeInteger(base.expectedRevision, "expectedRevision");
  if (!expectedRevision.ok) return expectedRevision;
  return { ok: true, data: { decisionId: decisionId.data, expectedRevision: expectedRevision.data, patch: {} } };
}

// ---------------------------------------------------------------------------
// task-377 ④ search extensions: the default list and the timeHorizon filter.
// task-393 ③: the refType/refId reverse filter ("which decisions reference X").

interface DecisionSearchParsedInput {
  /** undefined means the caller omitted query: list recent decisions (the
   * default list, requirements §10.5) instead of a keyword search. */
  query: string | undefined;
  timeHorizon: TimeHorizon | undefined;
  /** task-393: present together; filter decisions by an outgoing ref edge. */
  refType: DecisionRefType | undefined;
  refId: string | undefined;
  /** task-615 (609 G3): reverse supersession — "which decisions declare that
   * they replace this one". */
  replacedDecisionId: number | undefined;
  /** task-1 (原 task-624): the complement of refType/refId — "which decisions
   * carry NO edge of this type". The one query that answers requirements §3's
   * P0 alarm ("effective decision with no downstream task") in one call. */
  withoutRefType: DecisionRefType | undefined;
  /** task-1: opt-in per-hit edge-kind summary (default false keeps the page
   * byte shape of every existing caller unchanged). */
  withRefTypes: boolean;
  /** task-424 (D-1257): "literal" is the frozen 377 substring semantics,
   * byte-identical default; "keywords" splits query on Unicode whitespace and
   * requires every token to match (AND of per-token literal-substring groups).
   * Extracted here like timeHorizon/refType/refId — the frozen parser never
   * sees it. */
  queryMode: "literal" | "keywords";
  /** Tokenized query in keywords mode; [] in literal mode. */
  keywords: string[];
  includeVoided: boolean;
  limit: number;
  offset: number;
}

/** task-424: bounds the per-token LIKE groups (4 params each, 4N ≤ 64). */
const MAX_SEARCH_KEYWORDS = 16;

function parseSearchInput(input: unknown): DomainResult<DecisionSearchParsedInput> {
  if (!isPlainRecord(input)) {
    // Preserve the frozen parser's canonical non-object error.
    const passthrough = parseDecisionSearchInput(input);
    if (passthrough.ok) throw new TypeError("The frozen search parser accepted a non-object input.");
    return { ok: false, error: passthrough.error };
  }
  const rest: Record<string, unknown> = {};
  let timeHorizon: TimeHorizon | undefined;
  let refType: DecisionRefType | undefined;
  let refId: string | undefined;
  let replacedDecisionId: number | undefined;
  let withoutRefType: DecisionRefType | undefined;
  let withRefTypes = false;
  let queryMode: "literal" | "keywords" | undefined;
  let hasQuery = false;
  for (const [key, value] of Object.entries(input)) {
    if (key === "queryMode") {
      if (value !== "literal" && value !== "keywords") {
        return validationFailure("queryMode", "Expected 'literal' or 'keywords'.");
      }
      queryMode = value;
      continue;
    }
    if (key === "timeHorizon") {
      if (value !== "long_term" && value !== "temporary") {
        return validationFailure("timeHorizon", "Expected 'long_term' or 'temporary'.");
      }
      timeHorizon = value;
      continue;
    }
    if (key === "refType") {
      if (value !== undefined) {
        if (typeof value !== "string" || !(DECISION_REF_TYPES as readonly string[]).includes(value)) {
          // Same direction rule as the write face: bl is not a ref type a
          // decision may carry, so it is not a filter value either.
          return validationFailure("refType", "Expected ref type decision, task, plan or commit; a decision must not reference bl (direction rule).");
        }
        refType = value as DecisionRefType;
      }
      continue;
    }
    if (key === "withoutRefType") {
      if (value !== undefined) {
        if (typeof value !== "string" || !(DECISION_REF_TYPES as readonly string[]).includes(value)) {
          // Same closed type set as refType (one shared constant): the filter is
          // the complement of an edge kind that can actually exist.
          return validationFailure("withoutRefType", "Expected ref type decision, task, plan or commit; a decision must not reference bl (direction rule).");
        }
        withoutRefType = value as DecisionRefType;
      }
      continue;
    }
    if (key === "withRefTypes") {
      if (value !== undefined) {
        if (typeof value !== "boolean") return validationFailure("withRefTypes", "Expected a boolean.");
        withRefTypes = value;
      }
      continue;
    }
    if (key === "replacedDecisionId") {
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
          return validationFailure("replacedDecisionId", "Expected a positive safe integer decision number.");
        }
        replacedDecisionId = value;
      }
      continue;
    }
    if (key === "refId") {
      if (value !== undefined) {
        if (typeof value !== "string") return validationFailure("refId", "Expected a string of 1–200 code points.");
        if (value.includes("\u0000")) return validationFailure("refId", "NUL is not allowed.");
        const idLength = Array.from(value).length;
        if (idLength < 1 || idLength > 200) return validationFailure("refId", "Expected 1–200 Unicode code points.");
        if (isBlankContract(value)) return validationFailure("refId", "Must not be blank.");
        refId = value;
      }
      continue;
    }
    if (key === "query") {
      hasQuery = value !== undefined;
      if (hasQuery) rest.query = value;
      continue;
    }
    rest[key] = value;
  }
  // The reverse filter addresses the (ref_type, ref_key) index: both coordinates
  // are required, and a half filter is a caller error, not a silent full scan.
  if ((refType === undefined) !== (refId === undefined)) {
    return validationFailure(refType === undefined ? "refType" : "refId", "refType and refId must be provided together.");
  }
  // task-1: "has no edge of type X" and "has the edge (X, id)" cannot both hold.
  // Left unchecked this composes into a silently always-empty page — a filter
  // that can only be right by accident. Fail closed instead (D-1074).
  if (withoutRefType !== undefined && withoutRefType === refType) {
    return validationFailure("withoutRefType", "withoutRefType contradicts refType: a decision cannot both carry and not carry the same reference type.");
  }
  // task-424: the mode only modifies query; the default list has no query
  // semantics. Fail closed instead of silently ignoring the flag.
  if (queryMode !== undefined && !hasQuery) {
    return validationFailure("queryMode", "queryMode requires query; omit it for the default list.");
  }
  if (hasQuery) {
    // Keyword search keeps the frozen parser's exact validation (including the
    // rejection of an empty query string); only the extensions were extracted.
    const parsed = parseDecisionSearchInput(rest);
    if (!parsed.ok) return parserFailure(parsed);
    let keywords: string[] = [];
    if (queryMode === "keywords") {
      // Unicode whitespace split (JS \s covers the contract's whitespace set);
      // each token stays a literal substring with the frozen LIKE semantics.
      keywords = parsed.data.query.split(/\s+/u).filter((token) => token.length > 0);
      if (keywords.length > MAX_SEARCH_KEYWORDS) {
        return validationFailure("query", `Too many keywords: at most ${MAX_SEARCH_KEYWORDS} whitespace-separated tokens.`);
      }
    }
    return {
      ok: true,
      data: {
        query: parsed.data.query,
        timeHorizon,
        refType,
        refId,
        replacedDecisionId,
        withoutRefType,
        withRefTypes,
        queryMode: queryMode ?? "literal",
        keywords,
        includeVoided: parsed.data.includeVoided,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      },
    };
  }
  // Default list: no keyword. Bounds mirror the frozen search parser exactly.
  const allowed = new Set(["includeVoided", "limit", "offset"]);
  const extra = Object.keys(rest).find((key) => !allowed.has(key));
  if (extra !== undefined) return validationFailure(extra, "Unknown field.");
  let includeVoided = false;
  if (hasOwnProperty(rest, "includeVoided")) {
    if (typeof rest.includeVoided !== "boolean") return validationFailure("includeVoided", "Expected a boolean.");
    includeVoided = rest.includeVoided;
  }
  let limit = 10;
  if (hasOwnProperty(rest, "limit")) {
    const value = rest.limit;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 20) {
      return validationFailure("limit", "Expected an integer from 1 to 20.");
    }
    limit = value;
  }
  let offset = 0;
  if (hasOwnProperty(rest, "offset")) {
    const value = rest.offset;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return validationFailure("offset", "Expected a non-negative safe integer.");
    }
    offset = value;
  }
  return { ok: true, data: { query: undefined, timeHorizon, refType, refId, replacedDecisionId, withoutRefType, withRefTypes, queryMode: "literal" as const, keywords: [], includeVoided, limit, offset } };
}

function timestamp(): string {
  return new Date().toISOString();
}

function prepare(database: DatabaseSync, sql: string): Statement {
  let cache = statementCache.get(database);
  if (cache === undefined) {
    cache = new Map<string, Statement>();
    statementCache.set(database, cache);
  }
  let statement = cache.get(sql);
  if (statement === undefined) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function one<T>(database: DatabaseSync, sql: string, values: readonly BindValue[] = []): T | undefined {
  return prepare(database, sql).get(...values) as T | undefined;
}

function many<T>(database: DatabaseSync, sql: string, values: readonly BindValue[] = []): T[] {
  return prepare(database, sql).all(...values) as T[];
}

function run(database: DatabaseSync, sql: string, values: readonly BindValue[] = []): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return prepare(database, sql).run(...values);
}

function scalar<T>(database: DatabaseSync, sql: string): T {
  const row = one<Record<string, T>>(database, sql);
  if (row === undefined) throw new Error("Expected a PRAGMA result row.");
  const first = Object.values(row)[0];
  if (first === undefined) throw new Error("Expected a PRAGMA result value.");
  return first;
}

function toSafeId(value: number | bigint): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new RangeError("SQLite returned an identifier outside the supported safe-integer range.");
  }
  return numeric;
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.projectId,
    name: row.name,
    projectKey: row.projectKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    decisionId: row.decisionId,
    revision: row.revision,
    summary: row.summary,
    decision: row.decision,
    rationale: row.rationale,
    timeHorizon: row.timeHorizon,
    decisionDate: row.decisionDate,
    reviewDate: row.reviewDate,
    status: row.status,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    sourceReference: row.sourceReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Extended view for getDecision (task-377/393). Revision snapshots
 * deliberately keep the frozen DecisionRecord shape via toDecisionRecord. */
function toDecisionRecordView(row: DecisionRow, refs: DecisionRef[]): DecisionRecordView {
  return {
    ...toDecisionRecord(row),
    externalId: row.externalId,
    replaces: row.replacesJson === null ? null : JSON.parse(row.replacesJson) as number[],
    refs,
  };
}

function targetOfRow(row: DecisionRow): ExistingDecisionTarget {
  return {
    decisionId: row.decisionId,
    revision: row.revision,
    summary: row.summary,
    status: row.status,
    createdAt: row.createdAt,
    projectId: row.projectId,
  };
}

/** The receipt returned when an external_id already exists (requirements
 * §10.2): the caller receives the EXISTING record's identity, not a new row.
 * requestProjectId decides the ownership marker (task-600 ③): a hit inside the
 * caller's own project is a plain dedupe; a hit in another project adds
 * existingProjectId, because that decisionId cannot be read from here. */
function receiptForExisting(
  target: ExistingDecisionTarget,
  externalId: string,
  requestProjectId: number,
): DecisionCreateReceipt {
  return {
    decisionId: target.decisionId,
    revision: target.revision,
    summary: target.summary,
    status: target.status,
    createdAt: target.createdAt,
    externalId,
    alreadyExisted: true,
    ...(target.projectId === requestProjectId ? {} : { existingProjectId: target.projectId }),
  };
}

function decisionSelect(where: string): string {
  return `SELECT
    id AS decisionId,
    revision,
    project_id AS projectId,
    decision_text AS decision,
    summary,
    rationale,
    time_horizon AS timeHorizon,
    decision_date AS decisionDate,
    review_date AS reviewDate,
    status,
    void_reason AS voidReason,
    voided_at AS voidedAt,
    source_reference AS sourceReference,
    created_at AS createdAt,
    updated_at AS updatedAt,
    external_id AS externalId,
    replaces_json AS replacesJson
  FROM decisions ${where}`;
}

function checkNoNul(column: string): string {
  return `instr(CAST(${column} AS BLOB), X'00') = 0`;
}

function checkNoControls(column: string): string {
  const controls = [
    ...Array.from({ length: 31 }, (_, index) => index + 1),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ];
  return controls.map((codePoint) => `instr(${column}, char(${codePoint})) = 0`).join(" AND ");
}

function checkText(column: string, min: number, max: number): string {
  // The frozen contract counts stored text in Unicode code points (SQLite
  // length() on TEXT); trimming is only the non-blank test, so leading or
  // trailing White_Space must not consume the length budget.
  return `(${column} IS NULL OR (
    length(${column}) BETWEEN ${min} AND ${max}
    AND length(trim(${column}, ${UNICODE_WHITE_SPACE_SQL})) > 0
    AND ${checkNoNul(column)}
  ))`;
}

function checkDate(column: string): string {
  return `(${column} IS NULL OR (
    length(${column}) = 10
    AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(${column}, 1, 4) <> '0000'
    AND strftime('%Y-%m-%d', ${column}, '+0 days') IS NOT NULL
    AND strftime('%Y-%m-%d', ${column}, '+0 days') = ${column}
  ))`;
}

// task-377 ①: the external idempotency key. 1–200 code points, non-blank, no
// NUL; NULL means "no external key". Uniqueness is enforced by a unique index
// (SQLite allows multiple NULLs in a unique index, so keyless rows never clash).
const EXTERNAL_ID_COLUMN_SQL = `external_id TEXT CONSTRAINT ck_decisions_external_id CHECK (
    external_id IS NULL OR (
      length(external_id) BETWEEN 1 AND 200
      AND length(trim(external_id, ${UNICODE_WHITE_SPACE_SQL})) > 0
      AND ${checkNoNul("external_id")}
    )
  )`;

// task-377 ④: the replaces declaration, a JSON array of DSD decision numbers.
// The CHECK is the structural backstop for direct SQL writes (valid JSON array);
// element-level validation (positive safe integers, 1–100 entries, no repeats)
// happens in the store before every insert.
const REPLACES_JSON_COLUMN_SQL = `replaces_json TEXT CONSTRAINT ck_decisions_replaces_json CHECK (
    replaces_json IS NULL OR (
      json_valid(replaces_json)
      AND json_type(replaces_json) = 'array'
      AND length(replaces_json) BETWEEN 2 AND 100000
    )
  )`;

const SCHEMA_SQL = `
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
    length(trim(name, ${UNICODE_WHITE_SPACE_SQL})) BETWEEN 1 AND 64
    AND name = trim(name, ${UNICODE_WHITE_SPACE_SQL})
    AND ${checkNoNul("name")}
    AND ${checkNoControls("name")}
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)__STRICT__;

CREATE UNIQUE INDEX uq_projects_project_key ON projects(project_key);
CREATE INDEX idx_projects_name ON projects(name);

CREATE TABLE session_projects (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL CONSTRAINT ck_session_projects_session_id
    CHECK (length(session_id) > 0 AND ${checkNoNul("session_id")}),
  project_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT fk_session_projects_project_id
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
)__STRICT__;
CREATE UNIQUE INDEX uq_session_projects_session_id ON session_projects(session_id);
CREATE INDEX idx_session_projects_project_id ON session_projects(project_id);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_decisions_revision CHECK (revision > 0),
  project_id INTEGER NOT NULL,
  decision_text TEXT NOT NULL CONSTRAINT ck_decisions_text CHECK (
    length(decision_text) BETWEEN 1 AND 20000
    AND length(trim(decision_text, ${UNICODE_WHITE_SPACE_SQL})) > 0
    AND ${checkNoNul("decision_text")}
  ),
  summary TEXT CONSTRAINT ck_decisions_summary CHECK (${checkText("summary", 1, 300)}),
  rationale TEXT CONSTRAINT ck_decisions_rationale_length CHECK (${checkText("rationale", 1, 20000)}),
  time_horizon TEXT NOT NULL DEFAULT 'long_term'
    CONSTRAINT ck_decisions_time_horizon CHECK (time_horizon IN ('long_term', 'temporary')),
  decision_date TEXT CONSTRAINT ck_decisions_decision_date CHECK (${checkDate("decision_date")}),
  review_date TEXT CONSTRAINT ck_decisions_review_date CHECK (${checkDate("review_date")}),
  status TEXT NOT NULL DEFAULT 'effective'
    CONSTRAINT ck_decisions_status CHECK (status IN ('effective', 'voided')),
  void_reason TEXT,
  voided_at TEXT,
  source_reference TEXT CONSTRAINT ck_decisions_source_reference_length CHECK (${checkText("source_reference", 1, 4000)}),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${EXTERNAL_ID_COLUMN_SQL},
  ${REPLACES_JSON_COLUMN_SQL},
  CONSTRAINT ck_decisions_void_state CHECK (
    (status = 'effective' AND void_reason IS NULL AND voided_at IS NULL)
    OR
    (status = 'voided' AND void_reason IS NOT NULL
      AND length(void_reason) BETWEEN 1 AND 1000
      AND length(trim(void_reason, ${UNICODE_WHITE_SPACE_SQL})) > 0
      AND ${checkNoNul("void_reason")}
      AND voided_at IS NOT NULL)
  ),
  CONSTRAINT fk_decisions_project_id
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
)__STRICT__;
CREATE INDEX idx_decisions_project_updated ON decisions(project_id, updated_at DESC, id DESC);
CREATE UNIQUE INDEX uq_decisions_external_id ON decisions(external_id);

__REFS_TABLE__
CREATE UNIQUE INDEX uq_decision_refs_edge ON decision_refs(decision_id, ref_type, ref_key);
CREATE INDEX idx_decision_refs_reverse ON decision_refs(ref_type, ref_key);

__REPLACES_TABLE__
CREATE UNIQUE INDEX uq_decision_replaces_edge ON decision_replaces(decision_id, replaced_id);
CREATE INDEX idx_decision_replaces_reverse ON decision_replaces(replaced_id, decision_id);

CREATE TABLE decision_revisions (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL,
  change_kind TEXT NOT NULL CONSTRAINT ck_decision_revisions_change_kind
    CHECK (change_kind IN ('update', 'void')),
  snapshot_json TEXT NOT NULL CONSTRAINT ck_decision_revisions_snapshot_json
    CHECK (length(snapshot_json) > 0 AND ${checkNoNul("snapshot_json")}),
  created_at TEXT NOT NULL,
  CONSTRAINT fk_decision_revisions_decision_id
    FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE RESTRICT
)__STRICT__;
CREATE INDEX idx_decision_revisions_decision_created
  ON decision_revisions(decision_id, created_at DESC, id DESC);
`;

// task-377 ②③: typed reference edges. The ref_type CHECK is the direction rule
// (requirements §10.3): a decision may reference plan/task/commit/decision, never
// bl. uq_decision_refs_edge makes each edge unique per decision;
// idx_decision_refs_reverse is the reverse index (which decisions reference a
// given key) that the requirement asks to exist without a query API.
function decisionRefsTableSql(strict: boolean): string {
  return `CREATE TABLE decision_refs (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL,
  ref_type TEXT NOT NULL CONSTRAINT ck_decision_refs_type
    CHECK (ref_type IN ('decision', 'task', 'plan', 'commit')),
  ref_key TEXT NOT NULL CONSTRAINT ck_decision_refs_key CHECK (
    length(ref_key) BETWEEN 1 AND 200
    AND length(trim(ref_key, ${UNICODE_WHITE_SPACE_SQL})) > 0
    AND ${checkNoNul("ref_key")}
  ),
  created_at TEXT NOT NULL,
  CONSTRAINT fk_decision_refs_decision_id
    FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE RESTRICT
)${strict ? " STRICT" : ""};`;
}

// task-615 (609 G3): the supersession projection. One row per declared
// (declarer, replaced) pair; replaces_json remains the authority, this table is
// the index-backed projection the reverse query reads. replaced_id deliberately
// has NO foreign key: a decision may declare that it replaces a record that has
// not been imported yet (G1 forward references stay legal).
function decisionReplacesTableSql(strict: boolean): string {
  return `CREATE TABLE decision_replaces (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL,
  replaced_id INTEGER NOT NULL CONSTRAINT ck_decision_replaces_replaced_id
    CHECK (replaced_id > 0),
  created_at TEXT NOT NULL,
  CONSTRAINT uq_decision_replaces_edge UNIQUE (decision_id, replaced_id),
  CONSTRAINT fk_decision_replaces_decision_id
    FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE RESTRICT
)${strict ? " STRICT" : ""};`;
}

// SQLite 3.37+ parses the STRICT table suffix; older libraries must keep the
// plain schema. The runtime is probed instead of assumed.
function sqliteSupportsStrictTables(database: DatabaseSync): boolean {
  const version = String(scalar<string>(database, "SELECT sqlite_version() AS version"));
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error("Could not determine the SQLite library version.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 37);
}

function schemaSql(strict: boolean): string {
  return SCHEMA_SQL
    .replaceAll("__STRICT__", strict ? "STRICT" : "")
    .replace("__REFS_TABLE__", decisionRefsTableSql(strict))
    .replace("__REPLACES_TABLE__", decisionReplacesTableSql(strict));
}

// v1 -> v2 migration (task-377). ALTER TABLE ADD COLUMN appends the two new
// columns (matching the fresh-schema column order) and leaves every stored row
// untouched; existing rows get NULL external_id/replaces_json. The v1 column
// default 'temporary' cannot be changed without a table rebuild, which is not
// needed: every store insert passes time_horizon explicitly (long_term when the
// caller omitted it).
const MIGRATION_V1_TO_V2_SQL = `
ALTER TABLE decisions ADD COLUMN ${EXTERNAL_ID_COLUMN_SQL};
ALTER TABLE decisions ADD COLUMN ${REPLACES_JSON_COLUMN_SQL};
CREATE UNIQUE INDEX uq_decisions_external_id ON decisions(external_id);
__REFS_TABLE__
CREATE UNIQUE INDEX uq_decision_refs_edge ON decision_refs(decision_id, ref_type, ref_key);
CREATE INDEX idx_decision_refs_reverse ON decision_refs(ref_type, ref_key);
`;

// v2 -> v3 migration (task-615). Creates the projection and BACKFILLS it from
// the authority (decisions.replaces_json), using each declarer's own created_at
// so a historical declaration is not rewritten as if it happened today.
const MIGRATION_V2_TO_V3_SQL = `
__REPLACES_TABLE__
CREATE UNIQUE INDEX uq_decision_replaces_edge ON decision_replaces(decision_id, replaced_id);
CREATE INDEX idx_decision_replaces_reverse ON decision_replaces(replaced_id, decision_id);
INSERT INTO decision_replaces (decision_id, replaced_id, created_at)
  SELECT d.id, j.value, d.created_at
  FROM decisions d, json_each(d.replaces_json) j
  WHERE d.replaces_json IS NOT NULL AND json_valid(d.replaces_json);
`;

function schemaTableNames(database: DatabaseSync): string[] {
  return many<{ name: string }>(database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
}

function schemaIndexNames(database: DatabaseSync): string[] {
  return many<{ name: string }>(database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
}

const EXPECTED_TABLES_V1 = ["decision_revisions", "decisions", "projects", "session_projects"];
const EXPECTED_INDEXES_V1 = [
  "idx_decision_revisions_decision_created",
  "idx_decisions_project_updated",
  "idx_projects_name",
  "idx_session_projects_project_id",
  "uq_projects_project_key",
  "uq_session_projects_session_id",
];

// The v2 shape, used to validate a v2 database BEFORE migrating it to v3.
const EXPECTED_TABLES_V2 = ["decision_refs", "decision_revisions", "decisions", "projects", "session_projects"];
const EXPECTED_INDEXES_V2 = [
  "idx_decision_refs_reverse",
  "idx_decision_revisions_decision_created",
  "idx_decisions_project_updated",
  "idx_projects_name",
  "idx_session_projects_project_id",
  "uq_decision_refs_edge",
  "uq_decisions_external_id",
  "uq_projects_project_key",
  "uq_session_projects_session_id",
];

// The v3 shape: v2 plus the decision_replaces projection (task-615).
const EXPECTED_TABLES = ["decision_refs", "decision_replaces", "decision_revisions", "decisions", "projects", "session_projects"];
const EXPECTED_INDEXES = [
  "idx_decision_replaces_reverse",
  "uq_decision_replaces_edge",
  "idx_decision_refs_reverse",
  "idx_decision_revisions_decision_created",
  "idx_decisions_project_updated",
  "idx_projects_name",
  "idx_session_projects_project_id",
  "uq_decision_refs_edge",
  "uq_decisions_external_id",
  "uq_projects_project_key",
  "uq_session_projects_session_id",
];

function assertForeignKeyIntegrity(database: DatabaseSync): void {
  const violations = many<{ table: string; rowid: number | null; parent: string; fkid: number }>(
    database,
    "PRAGMA foreign_key_check",
  );
  if (violations.length > 0) {
    throw new Error("Database contains foreign key violations.");
  }
}

function assertSchemaShape(
  database: DatabaseSync,
  expectedTables: readonly string[] = EXPECTED_TABLES,
  expectedIndexes: readonly string[] = EXPECTED_INDEXES,
): void {
  const tables = schemaTableNames(database);
  if (tables.length !== expectedTables.length || expectedTables.some((name, index) => tables[index] !== name)) {
    throw new Error("Database schema does not match the supported decision-store tables.");
  }
  const indexes = schemaIndexNames(database);
  if (expectedIndexes.some((name) => !indexes.includes(name))) {
    throw new Error("Database is missing one or more required decision-store indexes.");
  }
  assertForeignKeyIntegrity(database);
}

function preflightSchema(database: DatabaseSync): number {
  const version = scalar<number>(database, "PRAGMA user_version");
  const tables = schemaTableNames(database);
  const indexes = schemaIndexNames(database);

  if (version === 0) {
    if (tables.length > 0 || indexes.length > 0) {
      throw new Error("Refusing to initialize an unversioned database containing application schema objects.");
    }
    return 0;
  }
  if (version === 1) {
    // A v1 database migrates to v3 on open. Refuse anything that is not exactly
    // the v1 shape BEFORE touching it, so a foreign file is never ALTERed.
    assertSchemaShape(database, EXPECTED_TABLES_V1, EXPECTED_INDEXES_V1);
    return 1;
  }
  if (version === 2) {
    // task-615: a v2 database migrates to v3. Same rule as v1 — validate the
    // shape we are about to ALTER, never a foreign file.
    assertSchemaShape(database, EXPECTED_TABLES_V2, EXPECTED_INDEXES_V2);
    return 2;
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported database schema version ${version}.`);
  }
  assertSchemaShape(database);
  return version;
}

function migrateSchemaV1ToV3(database: DatabaseSync): void {
  const strict = sqliteSupportsStrictTables(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    // Both steps inside ONE transaction: a v1 database either ends up fully at
    // v3 or is left exactly as it was. user_version only moves at the end, so a
    // failure mid-chain cannot look like a half-migrated v2 file.
    database.exec(MIGRATION_V1_TO_V2_SQL.replace("__REFS_TABLE__", decisionRefsTableSql(strict)));
    database.exec(MIGRATION_V2_TO_V3_SQL.replace("__REPLACES_TABLE__", decisionReplacesTableSql(strict)));
    assertForeignKeyIntegrity(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the original migration error. */ }
    throw error;
  }
  database.exec("PRAGMA optimize");
}

function migrateSchemaV2ToV3(database: DatabaseSync): void {
  const strict = sqliteSupportsStrictTables(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(MIGRATION_V2_TO_V3_SQL.replace("__REPLACES_TABLE__", decisionReplacesTableSql(strict)));
    assertForeignKeyIntegrity(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the original migration error. */ }
    throw error;
  }
  database.exec("PRAGMA optimize");
}

function initializeSchema(database: DatabaseSync, version: number): void {
  if (version === 0) {
    const strict = sqliteSupportsStrictTables(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(schemaSql(strict));
      assertForeignKeyIntegrity(database);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original schema error. */ }
      throw error;
    }
    database.exec("PRAGMA optimize");
  } else if (version === 1) {
    migrateSchemaV1ToV3(database);
  } else if (version === 2) {
    migrateSchemaV2ToV3(database);
  }
  assertSchemaShape(database);
}

/**
 * Fail-closed Config gate shared by the store and the Host Config resolver.
 * Never falls back to $DSH_HOME, process.cwd(), or any shared root, and never
 * creates parent directories.
 */
export function validateDatabasePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || !isAbsolute(value)) {
    throw new TypeError("An explicit absolute databasePath is required; Profile path resolution is not provided by this store.");
  }
  if (process.platform === "win32" && parse(value).root.length <= 1) {
    throw new TypeError("An explicit absolute databasePath is required; a drive-less rooted path would resolve against process.cwd().");
  }
  if (value === ":memory:") {
    throw new TypeError("This store requires an explicit file path; in-memory databases are not a Profile store.");
  }
  return value;
}

function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA cache_size = -20000");

    if (scalar<number>(database, "PRAGMA busy_timeout") !== 5000) {
      throw new Error("SQLite busy_timeout could not be configured.");
    }
    if (scalar<number>(database, "PRAGMA foreign_keys") !== 1) {
      throw new Error("SQLite foreign key enforcement could not be enabled.");
    }
    if (scalar<number>(database, "PRAGMA synchronous") !== 1) {
      throw new Error("SQLite synchronous=NORMAL could not be configured.");
    }
    if (scalar<number>(database, "PRAGMA cache_size") !== -20000) {
      throw new Error("SQLite cache_size could not be configured.");
    }

    // WAL changes the database file persistently, so validate its recorded schema first.
    const schemaVersion = preflightSchema(database);
    database.exec("PRAGMA journal_mode = WAL");
    if (String(scalar<string>(database, "PRAGMA journal_mode")).toLowerCase() !== "wal") {
      throw new Error("SQLite WAL mode is not available for the supplied database path.");
    }

    initializeSchema(database, schemaVersion);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* Keep the configuration/schema error. */ }
    statementCache.delete(database);
    throw error;
  }
}

function sqliteFailure<T>(error: unknown): DomainResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message)) {
    return failure("DATABASE_BUSY", "Database is temporarily busy.");
  }
  return failure("DATABASE_ERROR", "Database operation failed.");
}

function isProjectKeyUniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: projects\.project_key/i.test(message);
}

/**
 * Wall-clock ISO timestamp (millisecond precision).
 *
 * Used for values that are only displayed, never ordered on: `created_at` of a
 * project, a session binding, or a decision.
 */
function nowIso(): string {
  return new Date().toISOString();
}


function escapeLikeLiteral(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

/** Contract §3 search: preview is the summary when present, else the decision
 * text, truncated to 240 Unicode code points. */
function previewText(content: string): string {
  return Array.from(content).slice(0, 240).join("");
}

/**
 * Load the set of edge KINDS for a whole page of hits in ONE statement.
 *
 * Keyed by decision id; each value is ordered by the canonical DECISION_REF_TYPES
 * order, never by the SQL row order — a summary whose order depends on insertion
 * history is a fixture that passes today and drifts tomorrow, and the canonical
 * order is also what makes two pages comparable byte for byte.
 */
function searchItemRefTypes(database: DatabaseSync, decisionIds: readonly number[]): Map<number, Set<DecisionRefType>> {
  const kinds = new Map<number, Set<DecisionRefType>>();
  if (decisionIds.length === 0) return kinds;
  const placeholders = decisionIds.map(() => "?").join(", ");
  const rows = many<{ decisionId: number; refType: DecisionRefType }>(database,
    `SELECT DISTINCT decision_id AS decisionId, ref_type AS refType
      FROM decision_refs WHERE decision_id IN (${placeholders})`,
    [...decisionIds],
  );
  for (const row of rows) {
    const set = kinds.get(row.decisionId) ?? new Set<DecisionRefType>();
    set.add(row.refType);
    kinds.set(row.decisionId, set);
  }
  return kinds;
}

/** Canonical order: the shared type constant decides, not the database. */
function refTypesOf(kinds: Set<DecisionRefType> | undefined): DecisionRefType[] {
  return DECISION_REF_TYPES.filter((type) => kinds?.has(type) === true);
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.projectId,
    name: row.name,
    projectKey: row.projectKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SQLiteDecisionStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private closed = false;

  private constructor(databasePath: string, database: DatabaseSync) {
    this.databasePath = databasePath;
    this.database = database;
  }

  static open(options: unknown): SQLiteDecisionStore {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Store options must be an object containing databasePath.");
    }
    const databasePath = validateDatabasePath((options as Record<string, unknown>).databasePath);
    const database = openDatabase(databasePath);
    return new SQLiteDecisionStore(databasePath, database);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    statementCache.delete(this.database);
    this.closed = true;
  }

  createProject(input: unknown): DomainResult<ProjectRecord> {
    const parsed = parseProjectInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();
    const createdAt = nowIso();
    try {
      return this.transaction(() => {
        const result = run(this.database,
          "INSERT INTO projects (project_key, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [parsed.data.projectKey, parsed.data.name, createdAt, createdAt],
        );
        return {
          ok: true,
          data: {
            projectId: toSafeId(result.lastInsertRowid),
            name: parsed.data.name,
            projectKey: parsed.data.projectKey,
            createdAt,
            updatedAt: createdAt,
          },
        };
      });
    } catch (error) {
      if (isProjectKeyUniqueError(error)) {
        return validationFailure("projectKey", "Project key already exists in this Profile database.");
      }
      return sqliteFailure(error);
    }
  }

  createAndBindProject(sessionIdInput: unknown, projectInput: unknown): DomainResult<SessionBindingRecord> {
    const sessionId = validateSessionId(sessionIdInput);
    if (!sessionId.ok) return sessionId;
    const project = parseProjectInput(projectInput);
    if (!project.ok) return parserFailure(project);
    this.assertOpen();
    const createdAt = nowIso();

    try {
      return this.transaction(() => {
        const existing = one<{ projectId: number }>(this.database,
          "SELECT project_id AS projectId FROM session_projects WHERE session_id = ?",
          [sessionId.data],
        );
        if (existing !== undefined) {
          return validationFailure("sessionId", "Session is already bound to a project.");
        }
        const inserted = run(this.database,
          "INSERT INTO projects (project_key, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [project.data.projectKey, project.data.name, createdAt, createdAt],
        );
        const projectId = toSafeId(inserted.lastInsertRowid);
        run(this.database,
          "INSERT INTO session_projects (session_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [sessionId.data, projectId, createdAt, createdAt],
        );
        return {
          ok: true,
          data: {
            sessionId: sessionId.data,
            projectId,
            projectKey: project.data.projectKey,
            name: project.data.name,
            createdAt,
            updatedAt: createdAt,
          },
        };
      });
    } catch (error) {
      if (isProjectKeyUniqueError(error)) {
        return validationFailure("projectKey", "Project key already exists in this Profile database.");
      }
      return sqliteFailure(error);
    }
  }

  getProjectByKey(keyInput: unknown): DomainResult<ProjectRecord | null> {
    const key = parseProjectKey(keyInput);
    if (!key.ok) return parserFailure(key);
    this.assertOpen();
    try {
      const row = one<ProjectRow>(this.database,
        "SELECT id AS projectId, name, project_key AS projectKey, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE project_key = ?",
        [key.data],
      );
      return { ok: true, data: row === undefined ? null : rowToProject(row) };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  listProjects(): DomainResult<ProjectRecord[]> {
    this.assertOpen();
    try {
      const rows = many<ProjectRow>(this.database,
        "SELECT id AS projectId, name, project_key AS projectKey, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY name COLLATE NOCASE, project_key",
      );
      return { ok: true, data: rows.map(rowToProject) };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  bindSession(sessionIdInput: unknown, projectIdInput: unknown): DomainResult<SessionBindingRecord> {
    const sessionId = validateSessionId(sessionIdInput);
    if (!sessionId.ok) return sessionId;
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    this.assertOpen();
    const now = nowIso();
    try {
      return this.transaction(() => {
        const project = one<ProjectRow>(this.database,
          "SELECT id AS projectId, name, project_key AS projectKey, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?",
          [projectId.data],
        );
        if (project === undefined) return failure("PROJECT_REQUIRED", "Project does not exist.");

        const existing = one<{ projectId: number }>(this.database,
          "SELECT project_id AS projectId FROM session_projects WHERE session_id = ?",
          [sessionId.data],
        );
        if (existing !== undefined && existing.projectId !== projectId.data) {
          return validationFailure("sessionId", "Session is already bound to a different project.");
        }
        if (existing === undefined) {
          run(this.database,
            "INSERT INTO session_projects (session_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
            [sessionId.data, projectId.data, now, now],
          );
        }
        return { ok: true, data: { ...rowToProject(project), sessionId: sessionId.data } };
      });
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  getBoundProject(sessionIdInput: unknown): DomainResult<SessionBindingRecord | null> {
    const sessionId = validateSessionId(sessionIdInput);
    if (!sessionId.ok) return sessionId;
    this.assertOpen();
    try {
      const row = one<ProjectRow & { sessionId: string }>(this.database,
        `SELECT p.id AS projectId, p.name, p.project_key AS projectKey,
          p.created_at AS createdAt, p.updated_at AS updatedAt, sp.session_id AS sessionId
        FROM session_projects sp JOIN projects p ON p.id = sp.project_id
        WHERE sp.session_id = ?`,
        [sessionId.data],
      );
      return { ok: true, data: row === undefined ? null : { ...rowToProject(row), sessionId: row.sessionId } };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  createDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionCreateReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const split = parseCreateExtensions(input);
    if (!split.ok) return split;
    const parsed = parseDecisionCreateInput(split.data.base);
    if (!parsed.ok) return parserFailure(parsed);
    const item = buildInsertItem(parsed.data, split.data);
    this.assertOpen();
    try {
      return this.transaction(() => {
        // External-id dedupe runs INSIDE the write transaction: BEGIN IMMEDIATE
        // holds the writer lock from here to COMMIT, so no other connection can
        // insert the same key between this lookup and the insert. Repeating a
        // create (including after an interrupted batch run) returns the existing
        // record instead of producing a second row (requirements §10.2).
        if (item.externalId !== undefined) {
          const existing = one<DecisionRow>(this.database,
            decisionSelect("WHERE external_id = ?"),
            [item.externalId],
          );
          if (existing !== undefined) {
            return { ok: true, data: receiptForExisting(targetOfRow(existing), item.externalId, projectId.data) };
          }
        }
        return { ok: true, data: this.insertDecision(projectId.data, item) };
      });
    } catch (error) {
      if (isForeignKeyError(error)) return failure("PROJECT_REQUIRED", "Project is not available in this database.");
      const constraintField = decisionConstraintField(error);
      if (constraintField !== undefined) {
        return validationFailure(constraintField, "Value violates a persisted decision constraint.");
      }
      if (isExternalIdUniqueError(error)) {
        return validationFailure("externalId", "External id already exists in this Profile database.");
      }
      if (error instanceof SelfReplaceError) return validationFailure("replaces", error.message);
      return sqliteFailure(error);
    }
  }

  createDecisionsBatch(projectIdInput: unknown, input: unknown): DomainResult<DecisionBatchReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const batch = splitBatchInput(input);
    if (!batch.ok) return batch;
    const parsed = parseDecisionCreateBatchInput(batch.data.base);
    if (!parsed.ok) return parserFailure(parsed);
    const items = parsed.data.decisions.map((item, index) => buildInsertItem(item, batch.data.items[index]!));
    this.assertOpen();
    try {
      return this.transaction(() => {
        // All rows were parsed before the transaction opened; a rejected row
        // therefore comes from a persisted CHECK, not from input validation.
        //
        // External-id dedupe covers BOTH a row that already exists (an earlier
        // batch interrupted mid-run) and a row created earlier in THIS batch,
        // so the idempotency key works within and across batches (requirements
        // §10.2: create_batch's all-or-nothing rollback does not cover the gap
        // between batches).
        const targets = new Map<string, ExistingDecisionTarget>();
        const keys = items.flatMap((item) => (item.externalId === undefined ? [] : [item.externalId]));
        if (keys.length > 0) {
          const placeholders = keys.map(() => "?").join(", ");
          for (const row of many<DecisionRow>(this.database,
            decisionSelect(`WHERE external_id IN (${placeholders})`),
            keys,
          )) targets.set(row.externalId!, targetOfRow(row));
        }
        const decisions: DecisionBatchReceipt["decisions"] = [];
        let createdCount = 0;
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]!;
          try {
            let receipt: DecisionCreateReceipt;
            const target = item.externalId === undefined ? undefined : targets.get(item.externalId);
            if (target !== undefined) {
              receipt = receiptForExisting(target, item.externalId!, projectId.data);
            } else {
              receipt = this.insertDecision(projectId.data, item);
              createdCount += 1;
              if (item.externalId !== undefined) {
                targets.set(item.externalId, {
                  decisionId: receipt.decisionId,
                  revision: receipt.revision,
                  summary: receipt.summary,
                  status: receipt.status,
                  createdAt: receipt.createdAt,
                  projectId: projectId.data,
                });
              }
            }
            decisions.push({
              index: index + 1,
              decisionId: receipt.decisionId,
              revision: receipt.revision,
              ...(item.externalId === undefined ? {} : {
                externalId: item.externalId,
                alreadyExisted: receipt.alreadyExisted === true,
                ...(receipt.existingProjectId === undefined ? {} : { existingProjectId: receipt.existingProjectId }),
              }),
            });
          } catch (error) {
            if (error instanceof SelfReplaceError) throw new RowConstraintError(index + 1, "replaces");
            const constraintField = decisionConstraintField(error);
            if (constraintField === undefined) throw error;
            throw new RowConstraintError(index + 1, constraintField);
          }
        }
        return { ok: true, data: { createdCount, decisions } };
      });
    } catch (error) {
      if (error instanceof RowConstraintError) {
        return failure("VALIDATION_FAILED", "Value violates a persisted decision constraint.", error.field, error.itemIndex);
      }
      if (isForeignKeyError(error)) return failure("PROJECT_REQUIRED", "Project is not available in this database.");
      return sqliteFailure(error);
    }
  }

  getDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionRecordView> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionGetInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();
    try {
      const row = one<DecisionRow>(this.database,
        decisionSelect("WHERE id = ? AND project_id = ?"),
        [parsed.data.decisionId, projectId.data],
      );
      if (row === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");
      // task-393: the record carries its own outgoing edges, so decision_get
      // alone answers "does this decision reference a task" (and which ones).
      const refs = many<{ refType: DecisionRefType; refKey: string }>(this.database,
        "SELECT ref_type AS refType, ref_key AS refKey FROM decision_refs WHERE decision_id = ? ORDER BY id",
        [parsed.data.decisionId],
      ).map((edge) => ({ type: edge.refType, id: edge.refKey }));
      return { ok: true, data: toDecisionRecordView(row, refs) };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  searchDecisions(projectIdInput: unknown, input: unknown): DomainResult<DecisionSearchPage> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseSearchInput(input);
    if (!parsed.ok) return parsed;
    this.assertOpen();

    const { query, timeHorizon, refType, refId, replacedDecisionId, withoutRefType, withRefTypes, queryMode, keywords, includeVoided, limit, offset } = parsed.data;
    const whereParts = ["project_id = ?"];
    const values: BindValue[] = [projectId.data];
    if (!includeVoided) whereParts.push("status = 'effective'");
    if (timeHorizon !== undefined) {
      whereParts.push("time_horizon = ?");
      values.push(timeHorizon);
    }
    if (refType !== undefined && refId !== undefined) {
      // task-393 ③: the reverse query. The subquery is exactly the
      // idx_decision_refs_reverse(ref_type, ref_key) access path: "which
      // decisions reference this key" (requirements §11 item 3).
      whereParts.push("id IN (SELECT decision_id FROM decision_refs WHERE ref_type = ? AND ref_key = ?)");
      values.push(refType, refId);
    }
    if (withoutRefType !== undefined) {
      // task-1 (原 task-624): the complement of the reverse filter — "which
      // decisions have NO edge of this type". NOT EXISTS is the same access path
      // read the other way round: uq_decision_refs_edge leads with decision_id,
      // so each outer row costs one index probe and no table lookup. This is
      // requirements §3's P0 alarm ("effective but no downstream task") in ONE
      // call; a decision with no references at all satisfies it trivially, which
      // is why the "no refs at all" alarm condition needs no second parameter.
      whereParts.push("NOT EXISTS (SELECT 1 FROM decision_refs r WHERE r.decision_id = decisions.id AND r.ref_type = ?)");
      values.push(withoutRefType);
    }
    if (replacedDecisionId !== undefined) {
      // task-615 (609 G3): the reverse supersession query. The subquery is
      // exactly the idx_decision_replaces_reverse(replaced_id, decision_id)
      // access path: covering, so no table lookup is needed.
      whereParts.push("id IN (SELECT decision_id FROM decision_replaces WHERE replaced_id = ?)");
      values.push(replacedDecisionId);
    }
    if (query !== undefined) {
      if (queryMode === "keywords") {
        // task-424: one literal-substring group per token, groups AND-ed.
        // A single token is exactly the literal branch below.
        for (const token of keywords) {
          const pattern = escapeLikeLiteral(token);
          whereParts.push(`(decision_text LIKE ? ESCAPE '\\'
              OR summary LIKE ? ESCAPE '\\'
              OR rationale LIKE ? ESCAPE '\\'
              OR source_reference LIKE ? ESCAPE '\\')`);
          values.push(pattern, pattern, pattern, pattern);
        }
      } else {
        const pattern = escapeLikeLiteral(query);
        whereParts.push(`(decision_text LIKE ? ESCAPE '\\'
            OR summary LIKE ? ESCAPE '\\'
            OR rationale LIKE ? ESCAPE '\\'
            OR source_reference LIKE ? ESCAPE '\\')`);
        values.push(pattern, pattern, pattern, pattern);
      }
    }
    const sql = `SELECT id AS decisionId, summary, decision_text AS decision, status, time_horizon AS timeHorizon, external_id AS externalId, replaces_json AS replacesJson
      FROM decisions
      WHERE ${whereParts.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?`;
    values.push(limit + 1, offset);

    try {
      const rows = many<{ decisionId: number; summary: string | null; decision: string; status: DecisionStatus; timeHorizon: TimeHorizon; externalId: string | null; replacesJson: string | null }>(
        this.database,
        sql,
        values,
      );
      const hasMore = rows.length > limit;
      const selected = hasMore ? rows.slice(0, limit) : rows;
      // task-1: opt-in per-hit edge kinds. One extra query for the whole page
      // (not one per hit), so the 1+N shape of the old surface never comes back;
      // the page itself is unchanged — hasMore and the row order are computed
      // before the kinds are read, so pagination cannot depend on this flag.
      const refTypesByDecision = withRefTypes
        ? searchItemRefTypes(this.database, selected.map((row) => row.decisionId))
        : undefined;
      return {
        ok: true,
        data: {
          decisions: selected.map((row) => ({
            decisionId: row.decisionId,
            preview: previewText(row.summary ?? row.decision),
            status: row.status,
            timeHorizon: row.timeHorizon,
            externalId: row.externalId,
            replaces: row.replacesJson === null ? null : JSON.parse(row.replacesJson) as number[],
            ...(refTypesByDecision === undefined ? {} : { refTypes: refTypesOf(refTypesByDecision.get(row.decisionId)) }),
          })),
          hasMore,
        },
      };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  getDecisionHistory(projectIdInput: unknown, decisionIdInput: unknown): DomainResult<DecisionRevisionRecord[]> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const decisionId = parsePositiveSafeInteger(decisionIdInput, "decisionId");
    if (!decisionId.ok) return decisionId;
    this.assertOpen();

    try {
      const decision = one<{ decisionId: number }>(this.database,
        "SELECT id AS decisionId FROM decisions WHERE id = ? AND project_id = ?",
        [decisionId.data, projectId.data],
      );
      if (decision === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");

      const rows = many<RevisionRow>(this.database,
        `SELECT id AS revisionId, decision_id AS decisionId, change_kind AS changeKind,
          snapshot_json AS snapshotJson, created_at AS createdAt
        FROM decision_revisions WHERE decision_id = ? ORDER BY created_at DESC, id DESC`,
        [decisionId.data],
      );
      return {
        ok: true,
        data: rows.map((row) => ({
          revisionId: row.revisionId,
          decisionId: row.decisionId,
          changeKind: row.changeKind,
          snapshot: JSON.parse(row.snapshotJson) as DecisionRecord,
          createdAt: row.createdAt,
        })),
      };
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  updateDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionUpdateReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const split = splitUpdateInput(input);
    if (!split.ok) return split;
    // refs-only append: the frozen parser requires at least one content field,
    // so a patch carrying only refs is validated as an envelope instead
    // (task-405); mixed patches go through the frozen parser unchanged.
    const base = split.data.base;
    const refsOnly = split.data.refs !== undefined && isPlainRecord(base)
      && isPlainRecord(base.patch) && Object.keys(base.patch).length === 0;
    const parsed = refsOnly
      ? parseRefsOnlyUpdateEnvelope(base as Record<string, unknown>)
      : parseDecisionUpdateInput(base);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();

    try {
      return this.transaction(() => {
        const current = this.readDecision(projectId.data, parsed.data.decisionId);
        if (current === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");
        if (current.revision !== parsed.data.expectedRevision) {
          return failure("REVISION_CONFLICT", "Decision changed; read the latest version before deciding whether to retry.");
        }
        if (current.status === "voided") {
          return failure("DECISION_NOT_EDITABLE", "Voided decisions cannot be updated.");
        }

        // task-405 add-only append: INSERT OR IGNORE keeps every existing edge
        // (uq_decision_refs_edge); the store has no DELETE path on decision_refs,
        // so no input shape can remove a reference. Edges commit with the update.
        let refsAdded = 0;
        if (split.data.refs !== undefined) {
          const insertRef = prepare(this.database,
            "INSERT OR IGNORE INTO decision_refs (decision_id, ref_type, ref_key, created_at) VALUES (?, ?, ?, ?)");
          const edgeCreatedAt = this.nextUpdatedAt(projectId.data);
          for (const ref of split.data.refs) {
            refsAdded += Number(insertRef.run(current.decisionId, ref.type, ref.id, edgeCreatedAt).changes);
          }
        }

        const contentFields = Object.entries(parsed.data.patch)
          .filter(([field, value]) => current[field as keyof DecisionRow] !== value)
          .map(([field]) => field);
        const changedFields = refsAdded > 0 ? [...contentFields, "refs"] : contentFields;
        if (changedFields.length === 0) {
          return {
            ok: true,
            data: {
              decisionId: current.decisionId,
              revision: current.revision,
              changedFields: [],
              status: "effective",
              updatedAt: current.updatedAt,
            },
          };
        }

        const updatedAt = this.nextUpdatedAt(projectId.data);
        this.insertSnapshot(current, "update", updatedAt);
        if (contentFields.length > 0) {
          const columnFor: Record<string, string> = {
            decision: "decision_text",
            summary: "summary",
            rationale: "rationale",
            timeHorizon: "time_horizon",
            decisionDate: "decision_date",
            reviewDate: "review_date",
            sourceReference: "source_reference",
          };
          const setClauses = contentFields.map((field) => `${columnFor[field]} = ?`);
          const values: (string | number | null)[] = contentFields.map((field) => parsed.data.patch[field as keyof typeof parsed.data.patch] ?? null);
          values.push(updatedAt, parsed.data.decisionId, projectId.data, parsed.data.expectedRevision);
          const update = run(this.database,
            `UPDATE decisions SET ${setClauses.join(", ")}, updated_at = ?, revision = revision + 1
             WHERE id = ? AND project_id = ? AND revision = ? AND status = 'effective'`,
            values,
          );
          if (update.changes !== 1 && update.changes !== 1n) {
            throw new Error("Decision update did not affect exactly one row.");
          }
        } else {
          // refs-only append still advances the revision and timestamp; the
          // snapshot above keeps the frozen DecisionRecord shape (no refs key).
          const update = run(this.database,
            `UPDATE decisions SET updated_at = ?, revision = revision + 1
             WHERE id = ? AND project_id = ? AND revision = ? AND status = 'effective'`,
            [updatedAt, parsed.data.decisionId, projectId.data, parsed.data.expectedRevision],
          );
          if (update.changes !== 1 && update.changes !== 1n) {
            throw new Error("Decision update did not affect exactly one row.");
          }
        }
        const updated = this.readDecision(projectId.data, parsed.data.decisionId);
        if (updated === undefined) throw new Error("Updated decision could not be reread.");
        return {
          ok: true,
          data: {
            decisionId: updated.decisionId,
            revision: updated.revision,
            changedFields,
            status: "effective",
            updatedAt: updated.updatedAt,
          },
        };
      });
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  voidDecision(projectIdInput: unknown, input: unknown): DomainResult<DecisionVoidReceipt> {
    const projectId = parsePositiveSafeInteger(projectIdInput, "projectId");
    if (!projectId.ok) return projectId;
    const parsed = parseDecisionVoidInput(input);
    if (!parsed.ok) return parserFailure(parsed);
    this.assertOpen();

    try {
      return this.transaction(() => {
        const current = this.readDecision(projectId.data, parsed.data.decisionId);
        if (current === undefined) return failure("DECISION_NOT_FOUND", "Decision was not found.");
        if (current.revision !== parsed.data.expectedRevision) {
          return failure("REVISION_CONFLICT", "Decision changed; read the latest version before deciding whether to retry.");
        }
        if (current.status === "voided") {
          return {
            ok: true,
            data: {
              decisionId: current.decisionId,
              revision: current.revision,
              status: "voided",
              voidedAt: current.voidedAt!,
            },
          };
        }

        const voidedAt = this.nextUpdatedAt(projectId.data);
        this.insertSnapshot(current, "void", voidedAt);
        const update = run(this.database,
          `UPDATE decisions
           SET status = 'voided', void_reason = ?, voided_at = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND project_id = ? AND revision = ? AND status = 'effective'`,
          [parsed.data.reason, voidedAt, voidedAt, parsed.data.decisionId, projectId.data, parsed.data.expectedRevision],
        );
        if (update.changes !== 1 && update.changes !== 1n) {
          throw new Error("Decision void did not affect exactly one row.");
        }
        const updated = this.readDecision(projectId.data, parsed.data.decisionId);
        if (updated === undefined || updated.voidedAt === null) throw new Error("Voided decision could not be reread.");
        return {
          ok: true,
          data: {
            decisionId: updated.decisionId,
            revision: updated.revision,
            status: "voided",
            voidedAt: updated.voidedAt,
          },
        };
      });
    } catch (error) {
      return sqliteFailure(error);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Decision store is closed.");
  }

  private transaction<T>(operation: () => DomainResult<T>): DomainResult<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original transaction error. */ }
      throw error;
    }
  }

  /**
   * Allocate the next `updated_at` for this project, strictly increasing.
   *
   * Why not the wall clock alone: the contract sorts search results by
   * `updatedAt` then `decisionId`, both descending (contract line 114). Two writes
   * inside the same millisecond would share a timestamp and the tie-break would
   * collapse to id order, which is NOT the update order — the sort would silently
   * stop reflecting recency. Ticks are a display value; the ordering guarantee must
   * come from the store.
   *
   * The allocator reads the project's current maximum and returns
   * `max(now, maximum + 1ms)`. Because every decision write inside one project goes
   * through this single statement under `BEGIN IMMEDIATE`, the result is a total
   * order over that project's decisions without a new column, a second sequence
   * table, or a schema migration.
   *
   * Projects are independent: two projects may legitimately share a timestamp,
   * because search never spans projects.
   */
  private nextUpdatedAt(projectId: number): string {
    const maximum = one<{ latest: string | null }>(this.database,
      "SELECT max(updated_at) AS latest FROM decisions WHERE project_id = ?",
      [projectId],
    )?.latest ?? null;
    const latestMillis = maximum === null ? Number.NaN : Date.parse(maximum);
    const nowMillis = Date.now();
    const nextMillis = Number.isFinite(latestMillis) ? Math.max(nowMillis, latestMillis + 1) : nowMillis;
    return new Date(nextMillis).toISOString();
  }

  private insertDecision(projectId: number, input: DecisionInsertItem): DecisionCreateReceipt {
    const createdAt = nowIso();
    // The ordering tick is allocated separately from the display timestamp: a
    // create inside the same millisecond as a previous write must still sort after
    // it (see nextUpdatedAt).
    const updatedAt = this.nextUpdatedAt(projectId);
    const result = run(this.database,
      `INSERT INTO decisions (
        project_id, decision_text, summary, rationale, time_horizon,
        decision_date, review_date, status, void_reason, voided_at,
        source_reference, created_at, updated_at, external_id, replaces_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'effective', NULL, NULL, ?, ?, ?, ?, ?)`,
      [
        projectId,
        input.decision,
        input.summary ?? null,
        input.rationale ?? null,
        input.timeHorizon,
        input.decisionDate ?? null,
        input.reviewDate ?? null,
        input.sourceReference ?? null,
        createdAt,
        updatedAt,
        input.externalId ?? null,
        input.replaces === undefined ? null : JSON.stringify(input.replaces),
      ],
    );
    const decisionId = toSafeId(result.lastInsertRowid);
    // task-614 (609 G2): now that the id exists, reject a self-replacement.
    if (input.replaces !== undefined && input.replaces.includes(decisionId)) throw new SelfReplaceError();
    // Typed reference edges are part of the same write transaction; a decision
    // and its refs commit together (requirements §10.3).
    if (input.refs !== undefined && input.refs.length > 0) {
      const insertRef = prepare(this.database,
        "INSERT INTO decision_refs (decision_id, ref_type, ref_key, created_at) VALUES (?, ?, ?, ?)");
      for (const ref of input.refs) insertRef.run(decisionId, ref.type, ref.id, createdAt);
    }
    // task-615 (609 G3): the reverse-lookup projection, written in the SAME
    // transaction as the declaration, so the two cannot drift on the normal path.
    // replaces_json stays the authority (docs/replaces-reverse-lookup-design.md §3).
    if (input.replaces !== undefined && input.replaces.length > 0) {
      const insertReplaces = prepare(this.database,
        "INSERT INTO decision_replaces (decision_id, replaced_id, created_at) VALUES (?, ?, ?)");
      for (const replacedId of input.replaces) insertReplaces.run(decisionId, replacedId, createdAt);
    }
    return {
      decisionId,
      revision: 1,
      summary: input.summary ?? null,
      status: "effective",
      createdAt,
      // The extension markers appear only when the input carried externalId;
      // without it the receipt keeps exactly the frozen five-field shape.
      ...(input.externalId === undefined ? {} : { externalId: input.externalId, alreadyExisted: false }),
    };
  }

  private readDecision(projectId: number, decisionId: number): DecisionRow | undefined {
    return one<DecisionRow>(this.database,
      decisionSelect("WHERE id = ? AND project_id = ?"),
      [decisionId, projectId],
    );
  }

  private insertSnapshot(record: DecisionRow, changeKind: "update" | "void", createdAt: string): void {
    const snapshot = toDecisionRecord(record);
    run(this.database,
      `INSERT INTO decision_revisions (decision_id, change_kind, snapshot_json, created_at)
       VALUES (?, ?, ?, ?)`,
      [record.decisionId, changeKind, JSON.stringify(snapshot), createdAt],
    );
  }
}

function isForeignKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

/**
 * task-614 (609 G2): a decision may not declare that it replaces itself.
 *
 * A self-reference is meaningless ("this record supersedes itself") and puts a
 * self-loop in the supersession graph, so it is rejected rather than stored.
 * The row's own id only exists after the INSERT, so the check runs there and
 * throws: transaction() then rolls the whole write back, which keeps the batch
 * contract ("any failure leaves nothing behind") and lets the batch map the
 * failure onto a one-based itemIndex like any other row constraint.
 */
class SelfReplaceError extends Error {
  readonly field = "replaces";

  constructor() {
    super("A decision must not declare that it replaces itself.");
    this.name = "SelfReplaceError";
  }
}

// Frozen contract: errors attributable to one batch row carry a one-based
// itemIndex and the input field; transaction-level errors never fake them.
class RowConstraintError extends Error {
  readonly itemIndex: number;
  readonly field: string;

  constructor(itemIndex: number, field: string) {
    super("A batch row violated a persisted decision constraint.");
    this.itemIndex = itemIndex;
    this.field = field;
  }
}

const DECISION_CONSTRAINT_FIELDS: Record<string, string> = {
  ck_decisions_text: "decision",
  ck_decisions_summary: "summary",
  ck_decisions_rationale_length: "rationale",
  ck_decisions_source_reference_length: "sourceReference",
  ck_decisions_decision_date: "decisionDate",
  ck_decisions_review_date: "reviewDate",
  ck_decisions_time_horizon: "timeHorizon",
  ck_decisions_external_id: "externalId",
  ck_decisions_replaces_json: "replaces",
  ck_decision_refs_type: "refs",
  ck_decision_refs_key: "refs",
};

function decisionConstraintField(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /CHECK constraint failed: (ck_decisions?_[a-z_]+)/iu.exec(message);
  if (match === null) return undefined;
  return DECISION_CONSTRAINT_FIELDS[match[1]!.toLowerCase()];
}

function isExternalIdUniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: decisions\\.external_id/i.test(message);
}
