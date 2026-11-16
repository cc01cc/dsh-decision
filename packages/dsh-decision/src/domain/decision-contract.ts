export const DECISION_STATUSES = ["effective", "voided"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const TIME_HORIZONS = ["long_term", "temporary"] as const;
export type TimeHorizon = (typeof TIME_HORIZONS)[number];

export type DomainErrorCode =
  | "VALIDATION_FAILED"
  | "PROJECT_REQUIRED"
  | "DECISION_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "DECISION_NOT_EDITABLE"
  | "DATABASE_BUSY"
  | "DATABASE_ERROR";

export interface DomainErrorBody {
  code: DomainErrorCode;
  message: string;
  field?: string;
  itemIndex?: number;
}

export type DomainResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DomainErrorBody };

export interface ProjectInput {
  name: string;
  projectKey: string;
}

export interface DecisionFields {
  decision: string;
  summary?: string | null;
  rationale?: string | null;
  timeHorizon: TimeHorizon;
  decisionDate?: string | null;
  reviewDate?: string | null;
  sourceReference?: string | null;
}

export interface DecisionRecord {
  decisionId: number;
  revision: number;
  summary: string | null;
  decision: string;
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
}

export interface DecisionSearchInput {
  query: string;
  includeVoided: boolean;
  limit: number;
  offset: number;
}

export interface DecisionGetInput {
  decisionId: number;
}

export type DecisionCreateInput = DecisionFields;

export interface DecisionCreateBatchInput {
  decisions: DecisionCreateInput[];
}

export type DecisionUpdatePatch = Partial<
  Pick<
    DecisionFields,
    | "decision"
    | "summary"
    | "rationale"
    | "timeHorizon"
    | "decisionDate"
    | "reviewDate"
    | "sourceReference"
  >
>;

export interface DecisionUpdateInput {
  decisionId: number;
  expectedRevision: number;
  patch: DecisionUpdatePatch;
}

export interface DecisionVoidInput {
  decisionId: number;
  expectedRevision: number;
  reason: string;
}

const UNICODE_WHITE_SPACE = new Set<number>([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function isUnicodeWhiteSpace(codePoint: number): boolean {
  return (
    UNICODE_WHITE_SPACE.has(codePoint) ||
    (codePoint >= 0x2000 && codePoint <= 0x200a)
  );
}

function trimContractWhiteSpace(value: string): string {
  const points = Array.from(value);
  let start = 0;
  let end = points.length;

  while (start < end && isUnicodeWhiteSpace(points[start]!.codePointAt(0)!)) {
    start += 1;
  }
  while (end > start && isUnicodeWhiteSpace(points[end - 1]!.codePointAt(0)!)) {
    end -= 1;
  }
  return points.slice(start, end).join("");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function success<T>(data: T): DomainResult<T> {
  return { ok: true, data };
}

function invalid<T>(field: string, message: string, itemIndex?: number): DomainResult<T> {
  return {
    ok: false,
    error: {
      code: "VALIDATION_FAILED",
      message,
      field,
      ...(itemIndex === undefined ? {} : { itemIndex }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function unknownField(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(record).find((key) => !allowedSet.has(key));
}

function parseObject<T extends Record<string, unknown>>(
  input: unknown,
  allowed: readonly string[],
): DomainResult<T> {
  if (!isRecord(input)) return invalid("input", "Expected an object.");
  const extra = unknownField(input, allowed);
  if (extra !== undefined) return invalid(extra, "Unknown field.");
  return success(input as T);
}

function parseString(
  value: unknown,
  field: string,
  maxCodePoints: number,
  minCodePoints = 1,
): DomainResult<string> {
  if (typeof value !== "string") return invalid(field, "Expected a string.");
  if (value.includes("\u0000")) return invalid(field, "NUL is not allowed.");

  const length = codePointLength(value);
  if (length < minCodePoints || length > maxCodePoints) {
    return invalid(field, `Expected ${minCodePoints}–${maxCodePoints} Unicode code points.`);
  }
  if (trimContractWhiteSpace(value).length === 0) {
    return invalid(field, "Must not be blank.");
  }
  return success(value);
}

function parseNullableText(
  record: Record<string, unknown>,
  field: string,
  maxCodePoints: number,
): DomainResult<string | null | undefined> {
  if (!hasOwn(record, field)) return success(undefined);
  if (record[field] === null) return success(null);
  return parseString(record[field], field, maxCodePoints);
}

function parseTimeHorizon(value: unknown, field: string): DomainResult<TimeHorizon> {
  if (value === "long_term" || value === "temporary") return success(value);
  return invalid(field, "Expected 'long_term' or 'temporary'.");
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x001f || (codePoint >= 0x007f && codePoint <= 0x009f);
}

function hasControlCodePoint(value: string): boolean {
  return Array.from(value).some((char) => isControlCodePoint(char.codePointAt(0)!));
}

// The key format is checked here; uniqueness belongs to the current Profile DB.
function parseProjectKeyValue(value: unknown): DomainResult<string> {
  if (typeof value !== "string") return invalid("projectKey", "Expected a string.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    return invalid("projectKey", "Expected a lowercase ASCII kebab-case key.");
  }
  if (value.length > 48) return invalid("projectKey", "Must be at most 48 ASCII characters.");
  return success(value);
}

function parseProjectNameValue(value: unknown): DomainResult<string> {
  if (typeof value !== "string") return invalid("name", "Expected a string.");
  const name = trimContractWhiteSpace(value);
  const length = codePointLength(name);
  if (length < 1 || length > 64) {
    return invalid("name", "Expected 1–64 Unicode code points after trimming.");
  }
  if (hasControlCodePoint(name) || /[\r\n\u2028\u2029]/u.test(name)) {
    return invalid("name", "Project name must be a single line without control characters.");
  }
  return success(name);
}

function parseDate(value: unknown, field: string): DomainResult<string | null> {
  if (value === null) return success(null);
  if (typeof value !== "string") return invalid(field, "Expected a date string or null.");
  if (value.includes("\u0000")) return invalid(field, "NUL is not allowed.");

  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return invalid(field, "Expected a valid YYYY-MM-DD date.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return invalid(field, "Expected a valid YYYY-MM-DD date.");
  }

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) {
    return invalid(field, "Expected a valid YYYY-MM-DD date.");
  }
  return success(value);
}

function parseOptionalField<T>(
  record: Record<string, unknown>,
  field: string,
  parser: (value: unknown) => DomainResult<T>,
): DomainResult<T | undefined> {
  if (!hasOwn(record, field)) return success(undefined);
  return parser(record[field]);
}

function applyOptional<T extends object, K extends string, V>(
  target: T,
  field: K,
  value: V | undefined,
): void {
  if (value !== undefined) Object.assign(target, { [field]: value });
}

function parsePositiveSafeInteger(value: unknown, field: string): DomainResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalid(field, "Expected a positive safe integer.");
  }
  return success(value);
}

function parseDatePatchField(
  record: Record<string, unknown>,
  field: "decisionDate" | "reviewDate",
): DomainResult<string | null | undefined> {
  return parseOptionalField(record, field, (value) => parseDate(value, field));
}

export function parseProjectKey(input: unknown): DomainResult<string> {
  return parseProjectKeyValue(input);
}

export function parseProjectName(input: unknown): DomainResult<string> {
  return parseProjectNameValue(input);
}

export function parseProjectInput(input: unknown): DomainResult<ProjectInput> {
  const object = parseObject<Record<string, unknown>>(input, ["name", "projectKey"]);
  if (!object.ok) return object;

  const name = parseProjectNameValue(object.data.name);
  if (!name.ok) return name;
  const projectKey = parseProjectKeyValue(object.data.projectKey);
  if (!projectKey.ok) return projectKey;
  return success({ name: name.data, projectKey: projectKey.data });
}

export function parseDecisionSearchInput(input: unknown): DomainResult<DecisionSearchInput> {
  const object = parseObject<Record<string, unknown>>(input, [
    "query",
    "includeVoided",
    "limit",
    "offset",
  ]);
  if (!object.ok) return object;

  const query = parseString(object.data.query, "query", 500);
  if (!query.ok) return query;

  const includeVoided = object.data.includeVoided === undefined
    ? success(false)
    : typeof object.data.includeVoided === "boolean"
      ? success(object.data.includeVoided)
      : invalid<boolean>("includeVoided", "Expected a boolean.");
  if (!includeVoided.ok) return includeVoided;

  const limitValue = object.data.limit === undefined ? 10 : object.data.limit;
  if (typeof limitValue !== "number" || !Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 20) {
    return invalid("limit", "Expected an integer from 1 to 20.");
  }

  const offsetValue = object.data.offset === undefined ? 0 : object.data.offset;
  if (typeof offsetValue !== "number" || !Number.isSafeInteger(offsetValue) || offsetValue < 0) {
    return invalid("offset", "Expected a non-negative safe integer.");
  }

  return success({
    query: query.data,
    includeVoided: includeVoided.data,
    limit: limitValue,
    offset: offsetValue,
  });
}

export function parseDecisionGetInput(input: unknown): DomainResult<DecisionGetInput> {
  const object = parseObject<Record<string, unknown>>(input, ["decisionId"]);
  if (!object.ok) return object;
  const decisionId = parsePositiveSafeInteger(object.data.decisionId, "decisionId");
  if (!decisionId.ok) return decisionId;
  return success({ decisionId: decisionId.data });
}

export function parseDecisionCreateInput(input: unknown): DomainResult<DecisionCreateInput> {
  const object = parseObject<Record<string, unknown>>(input, [
    "summary",
    "decision",
    "rationale",
    "timeHorizon",
    "decisionDate",
    "reviewDate",
    "sourceReference",
  ]);
  if (!object.ok) return object;

  const decision = parseString(object.data.decision, "decision", 20_000);
  if (!decision.ok) return decision;
  const summary = parseNullableText(object.data, "summary", 300);
  if (!summary.ok) return summary;
  const rationale = parseNullableText(object.data, "rationale", 20_000);
  if (!rationale.ok) return rationale;
  const sourceReference = parseNullableText(object.data, "sourceReference", 4_000);
  if (!sourceReference.ok) return sourceReference;
  // task-46（唯一真相 = long_term）：此处曾是 temporary（冻结契约 spec 表 line 99 的旧值），
  // 而 store 层对「原始输入省略 timeHorizon」一律落 long_term，工具描述也写 long_term ——
  // 同一字段出现两个相反缺省，调用方省略时「按描述读长期、按解析器读临时」。
  // 现按工具面已落地行为（生产库 1286 条实测全部 long_term）与语义（temporary = 缓做，
  // 误标比保守更糟）统一为 long_term；契约 spec 表那一行待用户裁定后同批改文。
  const timeHorizon = object.data.timeHorizon === undefined
    ? success<TimeHorizon>("long_term")
    : parseTimeHorizon(object.data.timeHorizon, "timeHorizon");
  if (!timeHorizon.ok) return timeHorizon;
  const decisionDate = parseDatePatchField(object.data, "decisionDate");
  if (!decisionDate.ok) return decisionDate;
  const reviewDate = parseDatePatchField(object.data, "reviewDate");
  if (!reviewDate.ok) return reviewDate;

  const result: DecisionCreateInput = {
    decision: decision.data,
    timeHorizon: timeHorizon.data,
  };
  applyOptional(result, "summary", summary.data);
  applyOptional(result, "rationale", rationale.data);
  applyOptional(result, "sourceReference", sourceReference.data);
  applyOptional(result, "decisionDate", decisionDate.data);
  applyOptional(result, "reviewDate", reviewDate.data);
  return success(result);
}

export function parseDecisionCreateBatchInput(input: unknown): DomainResult<DecisionCreateBatchInput> {
  const object = parseObject<Record<string, unknown>>(input, ["decisions"]);
  if (!object.ok) return object;
  const decisions = object.data.decisions;
  if (!Array.isArray(decisions)) return invalid("decisions", "Expected an array.");
  if (decisions.length < 1 || decisions.length > 100) {
    return invalid("decisions", "Expected 1–100 decisions.");
  }

  const parsed: DecisionCreateInput[] = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const item = parseDecisionCreateInput(decisions[index]);
    if (!item.ok) {
      return {
        ok: false,
        error: { ...item.error, itemIndex: index + 1 },
      };
    }
    parsed.push(item.data);
  }
  return success({ decisions: parsed });
}

export function parseDecisionUpdateInput(input: unknown): DomainResult<DecisionUpdateInput> {
  const object = parseObject<Record<string, unknown>>(input, [
    "decisionId",
    "expectedRevision",
    "patch",
  ]);
  if (!object.ok) return object;

  const decisionId = parsePositiveSafeInteger(object.data.decisionId, "decisionId");
  if (!decisionId.ok) return decisionId;
  const expectedRevision = parsePositiveSafeInteger(object.data.expectedRevision, "expectedRevision");
  if (!expectedRevision.ok) return expectedRevision;
  const patchObject = parseObject<Record<string, unknown>>(object.data.patch, [
    "decision",
    "summary",
    "rationale",
    "timeHorizon",
    "decisionDate",
    "reviewDate",
    "sourceReference",
  ]);
  if (!patchObject.ok) {
    return {
      ok: false,
      error: { ...patchObject.error, field: `patch.${patchObject.error.field ?? "input"}` },
    };
  }
  if (Object.keys(patchObject.data).length === 0) {
    return invalid("patch", "Patch must contain at least one field.");
  }

  const patch: DecisionUpdatePatch = {};
  if (hasOwn(patchObject.data, "decision")) {
    const value = parseString(patchObject.data.decision, "patch.decision", 20_000);
    if (!value.ok) return value;
    patch.decision = value.data;
  }
  const summary = parseNullableText(patchObject.data, "summary", 300);
  if (!summary.ok) return summary;
  applyOptional(patch, "summary", summary.data);
  const rationale = parseNullableText(patchObject.data, "rationale", 20_000);
  if (!rationale.ok) return rationale;
  applyOptional(patch, "rationale", rationale.data);
  const sourceReference = parseNullableText(patchObject.data, "sourceReference", 4_000);
  if (!sourceReference.ok) return sourceReference;
  applyOptional(patch, "sourceReference", sourceReference.data);

  if (hasOwn(patchObject.data, "timeHorizon")) {
    const value = parseTimeHorizon(patchObject.data.timeHorizon, "patch.timeHorizon");
    if (!value.ok) return value;
    patch.timeHorizon = value.data;
  }
  const decisionDate = parseDatePatchField(patchObject.data, "decisionDate");
  if (!decisionDate.ok) return decisionDate;
  applyOptional(patch, "decisionDate", decisionDate.data);
  const reviewDate = parseDatePatchField(patchObject.data, "reviewDate");
  if (!reviewDate.ok) return reviewDate;
  applyOptional(patch, "reviewDate", reviewDate.data);

  return success({
    decisionId: decisionId.data,
    expectedRevision: expectedRevision.data,
    patch,
  });
}

export function parseDecisionVoidInput(input: unknown): DomainResult<DecisionVoidInput> {
  const object = parseObject<Record<string, unknown>>(input, [
    "decisionId",
    "expectedRevision",
    "reason",
  ]);
  if (!object.ok) return object;

  const decisionId = parsePositiveSafeInteger(object.data.decisionId, "decisionId");
  if (!decisionId.ok) return decisionId;
  const expectedRevision = parsePositiveSafeInteger(object.data.expectedRevision, "expectedRevision");
  if (!expectedRevision.ok) return expectedRevision;
  const reason = parseString(object.data.reason, "reason", 1_000);
  if (!reason.ok) return reason;
  return success({
    decisionId: decisionId.data,
    expectedRevision: expectedRevision.data,
    reason: reason.data,
  });
}
