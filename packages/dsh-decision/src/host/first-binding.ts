/**
 * First-call project selection provider for the DSD plugin Host face
 * (PLAN-0778 T2.2, rulings D1/D2/D3/D4).
 *
 * Frozen contract anchors (plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md):
 * - line 79: the FIRST CALL OF ANY decision tool on an unbound session presents the
 *   existing projects as a DSH question card labelled 名称 · key plus a 新建项目
 *   option; a user must pick by key even when names are identical, and silent
 *   auto-binding is forbidden. (Ruling D1: this provider is reusable by all six
 *   tools, so it cannot be welded into one tool.)
 * - line 80: creating a project collects name and project_key in FOUR steps:
 *   (1) ask for the name;
 *   (2) prefill an editable lowercase kebab-case suggestion built only from ASCII
 *   letters/digits in the name, never transliterating Chinese;
 *   (3) on a key conflict offer -2, -3 suffixes and re-check uniqueness inside the
 *   current Profile DB;
 *   (4) when no suggestion is possible (pure Chinese) require the user to type a
 *   legal ASCII key.
 *   Cancelling or timing out writes no project and performs no decision operation.
 *   (Ruling D2: line 80 is the specification; the card summary is not.)
 * - line 82: selecting an existing project writes the binding; creating commits
 *   creation and binding in one transaction.
 * - line 84: creation accepts {name, projectKey} and returns {projectId, name, projectKey}.
 *
 * Timeout semantics: the built-in askTimed RESOLVES with {pending: true, callId}
 * instead of throwing (@deepseek-ai/dsh-user-questions/lib/index.js:648-651,
 * version 0.2.2-rc.1), so a timeout must be handled as its own branch that writes
 * nothing — not as a caught exception.
 *
 * Ruling D3: record-level project scoping stays in PLAN-0779. This module only
 * produces the project id for the current session.
 */

import type { DomainErrorBody, DomainResult } from "../domain/decision-contract.ts";
import { parseProjectKey, parseProjectName } from "../domain/decision-contract.ts";
import { suggestProjectKey } from "../domain/project-key-suggestion.ts";
import type { ProjectRecord, SessionBindingRecord } from "../storage/sqlite-store.ts";
import type { CallerSession, LiveAgentRegistry } from "./caller.ts";
import { requireCaller } from "./caller.ts";

/** Label of the create-new option (contract line 79 wording). */
export const NEW_PROJECT_LABEL = "新建项目";

/** Separator used by the contract's 名称 · key label (line 79). */
export const PROJECT_LABEL_SEPARATOR = " · ";

/**
 * The option label a user sees for an existing project.
 *
 * The key is part of the label so a selection carries the project's identity:
 * two projects may share a name, but never a key inside one Profile DB.
 */
export function projectOptionLabel(project: { readonly name: string; readonly projectKey: string }): string {
  return project.name + PROJECT_LABEL_SEPARATOR + project.projectKey;
}

/** What the Host asks the user, in the vocabulary this provider owns. */
export interface AskPrompt {
  readonly id: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
}

/** The user's reply to one prompt. */
export interface AskReply {
  readonly selected: readonly string[];
  readonly custom?: string;
}

/**
 * Outcome of asking the user.
 *
 * pending is the askTimed timeout branch, NOT an exception: contract line 80
 * requires a timeout to write nothing, so it must be distinguishable from both
 * an answer and a cancellation.
 */
export type AskOutcome =
  | { readonly kind: "answered"; readonly reply: AskReply }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "pending"; readonly callId: string };

/**
 * The asking surface this provider needs.
 *
 * Declared narrow so the Host's userQuestions service (or a test double) can
 * satisfy it: ask() for a blocking prompt and askTimed() for a windowed one.
 */
export interface QuestionAsker {
  ask(agent: unknown, prompt: AskPrompt): Promise<AskOutcome>;
  askTimed(agent: unknown, prompt: AskPrompt, callId: string, timeoutMs: number): Promise<AskOutcome>;
}

export interface FirstBindingStore {
  listProjects(): DomainResult<ProjectRecord[]>;
  getProjectByKey(key: string): DomainResult<ProjectRecord | null>;
  getBoundProject(sessionId: string): DomainResult<SessionBindingRecord | null>;
  bindSession(sessionId: string, projectId: unknown): DomainResult<SessionBindingRecord>;
  createAndBindProject(sessionId: string, projectInput: unknown): DomainResult<SessionBindingRecord>;
}

/** The single outlet later faces consume (ruling D1: one reusable provider). */
export interface SessionProject {
  readonly projectId: number;
  readonly name: string;
  readonly projectKey: string;
}

export type SessionProjectOutcome =
  | { readonly ok: true; readonly project: SessionProject }
  | { readonly ok: false; readonly reason: string; readonly message: string }
  | { readonly ok: false; readonly error: DomainErrorBody };

function isOutcomePending(outcome: AskOutcome): outcome is Extract<AskOutcome, { kind: "pending" }> {
  return outcome.kind === "pending";
}

/**
 * Build the project-choice question (contract line 79).
 *
 * Every existing project becomes exactly one option whose label embeds its key.
 * The create-new option is always last so it never displaces a real project.
 */
export function buildProjectChoicePrompt(projects: readonly ProjectRecord[]): AskPrompt {
  return {
    id: "dsd-project-choice",
    question: "请选择当前会话要使用的项目，或新建项目。同名项目请按 key 区分。",
    options: [
      ...projects.map((project) => ({
        label: projectOptionLabel(project),
        description: "已有项目",
      })),
      { label: NEW_PROJECT_LABEL, description: "创建新项目并绑定到当前会话" },
    ],
    multiSelect: false,
  };
}

/**
 * Resolve the user's selection to a project identity (contract line 79).
 *
 * Two reply shapes are resolved, both by EXACT identity only:
 *
 * 1. a clicked option — matched against the full 名称 · key label, which embeds
 *    the key, so two projects that share a name stay distinguishable;
 * 2. a typed answer (`selected: []` + `custom`) — matched against the label,
 *    then the projectKey, then the name. The name form is accepted ONLY when it
 *    is unique in this Profile: matching by name (or by prefix, or by position)
 *    would let a selection silently land on a different project when two
 *    projects share a name — that is the failure the contract forbids.
 *
 * A reply with no option and no text is a SKIP (task-14): the card was
 * dismissed, nothing is owned, and the refusal must say so instead of reusing
 * the ambiguous-selection wording (the old single message made a skip look like
 * a menu error, which is what made the failure unreadable in the field).
 */
export type ProjectChoice =
  | { readonly kind: "existing"; readonly project: ProjectRecord }
  | { readonly kind: "new" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Refusal text when the card was answered without a selection.
 *
 * Exported so tools/tests can pin the wording: the operator sees this string
 * through the Agent tool result, and it has to state (a) that a skip happened,
 * (b) that nothing was written, (c) exactly how to proceed.
 */
export const PROJECT_SKIPPED_MESSAGE =
  "The project question was answered without a selection, so nothing was written. " +
  "Call the tool again and pick a project by its 名称 · key label, or pick 新建项目 to create one.";

/** Refusal text when a typed answer matches no project in this Profile. */
export const PROJECT_TYPED_UNKNOWN_MESSAGE =
  "The typed answer matches no project in this Profile. Pick one of the offered 名称 · key labels, " +
  "or type a project key exactly as it appears after the separator.";

/** Refusal text when a typed answer names more than one project. */
export const PROJECT_TYPED_AMBIGUOUS_MESSAGE =
  "The typed answer matches more than one project name in this Profile; pick the 名称 · key label instead.";

export function resolveProjectChoice(reply: AskReply, projects: readonly ProjectRecord[]): ProjectChoice {
  const labels = reply.selected;
  if (labels.length > 1) {
    // multiSelect is false, so more than one label is a malformed reply, not a user choice.
    return { kind: "refused", message: "Select exactly one project option." };
  }
  if (labels.length === 1) {
    const label = labels[0];
    if (label === NEW_PROJECT_LABEL) return { kind: "new" };

    const matches = projects.filter((project) => projectOptionLabel(project) === label);
    if (matches.length === 1) return { kind: "existing", project: matches[0] };
    if (matches.length > 1) {
      return { kind: "refused", message: "The selected option label is ambiguous in this Profile." };
    }
    return {
      kind: "refused",
      message: "Select an offered option; a project is identified by its 名称 · key label, not by name alone.",
    };
  }

  const typed = (reply.custom ?? "").trim();
  if (typed === "") {
    // No option, no text: the user skipped the card. Nothing was written.
    return { kind: "refused", message: PROJECT_SKIPPED_MESSAGE };
  }
  return resolveTypedChoice(typed, projects);
}

/**
 * Resolve a typed answer by exact identity: label, then key, then unique name.
 *
 * Order matters: the label embeds the key, so a label hit is always the most
 * specific answer. Every branch rejects rather than guesses — no prefix, no
 * case folding, no "first match wins".
 */
function resolveTypedChoice(typed: string, projects: readonly ProjectRecord[]): ProjectChoice {
  if (typed === NEW_PROJECT_LABEL) return { kind: "new" };

  const byLabel = projects.filter((project) => projectOptionLabel(project) === typed);
  if (byLabel.length === 1) return { kind: "existing", project: byLabel[0] };
  if (byLabel.length > 1) return { kind: "refused", message: PROJECT_TYPED_AMBIGUOUS_MESSAGE };

  const byKey = projects.filter((project) => project.projectKey === typed);
  if (byKey.length === 1) return { kind: "existing", project: byKey[0] };
  if (byKey.length > 1) return { kind: "refused", message: PROJECT_TYPED_AMBIGUOUS_MESSAGE };

  const byName = projects.filter((project) => project.name === typed);
  if (byName.length === 1) return { kind: "existing", project: byName[0] };
  if (byName.length > 1) return { kind: "refused", message: PROJECT_TYPED_AMBIGUOUS_MESSAGE };

  return { kind: "refused", message: PROJECT_TYPED_UNKNOWN_MESSAGE };
}

/** Step 1 of contract line 80: collect and validate the project name. */
export function readProjectName(input: unknown): DomainResult<string> {
  return parseProjectName(input) as DomainResult<string>;
}

/**
 * Step 2/3 of contract line 80: the editable key suggestion.
 *
 * The BASE suggestion is the ASCII-only kebab-case slug of the name, unfixed for
 * collisions, because the contract shows the user the suggestion first and only
 * then offers alternates: step 2 pre-fills it, step 3 offers -2/-3 when the base
 * already exists in this Profile DB. Nothing is transliterated: the slug joins
 * ASCII alphanumeric runs only.
 *
 * `suggestion` is null when the name yields no ASCII fragments (pure Chinese);
 * step 4 then requires the user to type a legal key instead.
 */
export interface KeySuggestion {
  readonly suggestion: string | null;
  readonly conflicts: readonly string[];
}

export function buildKeySuggestion(
  name: string,
  existingKeys: readonly string[],
): KeySuggestion {
  // Passing an empty key list returns the un-suffixed base slug.
  const base = suggestProjectKey(name, []);
  if (base === null) return { suggestion: null, conflicts: [] };
  if (!existingKeys.includes(base)) return { suggestion: base, conflicts: [] };

  // The base is taken in this Profile DB: offer the -2/-3 style alternates that
  // are still free. These are candidates only; the Host re-checks uniqueness after
  // the user confirms (contract line 80 step 3).
  const alternates: string[] = [];
  for (let suffix = 2; alternates.length < 3 && suffix <= 12; suffix += 1) {
    const prefixLength = 48 - String(suffix).length - 1;
    const prefix = base.slice(0, prefixLength).replace(/-+$/u, "");
    const candidate = prefix + "-" + String(suffix);
    if (!existingKeys.includes(candidate) && !alternates.includes(candidate)) {
      alternates.push(candidate);
    }
  }
  return { suggestion: base, conflicts: alternates };
}

/** Step 4 fallback: a hand-typed key must still satisfy the Q1 key format. */
export function readProjectKey(input: unknown): DomainResult<string> {
  return parseProjectKey(input) as DomainResult<string>;
}

function refusal(message: string): SessionProjectOutcome {
  return { ok: false, reason: "PROJECT_REQUIRED", message };
}

function fromDomainError<_T>(result: { readonly ok: false; readonly error: DomainErrorBody }): SessionProjectOutcome {
  return { ok: false, error: result.error };
}

function projectOf(record: { readonly projectId: number; readonly name: string; readonly projectKey: string }): SessionProject {
  return { projectId: record.projectId, name: record.name, projectKey: record.projectKey };
}

export interface FirstBindingDeps {
  readonly agents: LiveAgentRegistry;
  readonly openStore: () => FirstBindingStore;
  readonly asker: QuestionAsker;
}

export interface FirstBindingOptions {
  /** When set, the choice prompt is windowed; the pending branch writes nothing. */
  readonly timeoutMs?: number;
  /** Stable call id for the windowed prompt (the Host tracks foreground waits by it). */
  readonly callId?: string;
}

/**
 * Resolve the current session's project, asking the user only on first use.
 *
 * Order (contract line 78): caller gate first, then the already-bound fast path,
 * then the question card. A refused caller never reaches the store.
 *
 * Every early return below writes nothing: cancelled, pending (timeout), refused
 * choice, invalid name, and unconfirmed key all leave the Profile DB untouched.
 */
export async function resolveSessionProject(
  agent: unknown,
  deps: FirstBindingDeps,
  options: FirstBindingOptions = {},
): Promise<SessionProjectOutcome> {
  const decision = requireCaller(agent, deps.agents);
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, message: decision.message };
  }
  const caller: CallerSession = decision.caller;
  const store = deps.openStore();

  // Fast path: an already bound session never sees a question (contract line 79 is
  // about the first call only).
  const bound = store.getBoundProject(caller.sessionId);
  if (!bound.ok) return fromDomainError(bound);
  if (bound.data !== null) return { ok: true, project: projectOf(bound.data) };

  const listed = store.listProjects();
  if (!listed.ok) return fromDomainError(listed);
  const projects = listed.data;

  const prompt = buildProjectChoicePrompt(projects);
  const outcome = options.timeoutMs === undefined
    ? await deps.asker.ask(caller.agent, prompt)
    : await deps.asker.askTimed(caller.agent, prompt, options.callId ?? prompt.id, options.timeoutMs);

  if (isOutcomePending(outcome)) return refusal("The user did not answer in time; nothing was written.");
  if (outcome.kind === "cancelled") return refusal(outcome.reason);

  const choice = resolveProjectChoice(outcome.reply, projects);
  if (choice.kind === "refused") return refusal(choice.message);

  if (choice.kind === "existing") {
    const binding = store.bindSession(caller.sessionId, choice.project.projectId);
    if (!binding.ok) return fromDomainError(binding);
    return { ok: true, project: projectOf(binding.data) };
  }

  return createProjectThroughDialog(caller, store, deps);
}

/**
 * Contract line 80 steps 1-4, then create-and-bind in one transaction (line 82).
 */
async function createProjectThroughDialog(
  caller: CallerSession,
  store: FirstBindingStore,
  deps: FirstBindingDeps,
): Promise<SessionProjectOutcome> {
  // Step 1: the name.
  const nameOutcome = await deps.asker.ask(caller.agent, {
    id: "dsd-project-name",
    question: "新项目名称？",
    options: [],
    multiSelect: false,
  });
  if (isOutcomePending(nameOutcome)) return refusal("The user did not answer in time; nothing was written.");
  if (nameOutcome.kind === "cancelled") return refusal(nameOutcome.reason);
  const nameInput = nameOutcome.reply.custom ?? nameOutcome.reply.selected[0];
  const name = readProjectName(nameInput);
  if (!name.ok) return fromDomainError(name);

  // Step 2 (and 3 when the suggestion collides): the editable key.
  const listed = store.listProjects();
  if (!listed.ok) return fromDomainError(listed);
  const existingKeys = listed.data.map((project) => project.projectKey);
  const suggestion = buildKeySuggestion(name.data, existingKeys);

  const keyPrompt: AskPrompt = {
    id: "dsd-project-key",
    question: suggestion.suggestion === null
      ? "该名称无法生成 ASCII key，请填写符合规则的小写 kebab-case key。"
      : "确认项目 key（可直接修改）。",
    options: suggestion.suggestion === null
      ? []
      : [suggestion.suggestion, ...suggestion.conflicts].map((candidate) => ({"label": candidate})),
    multiSelect: false,
  };
  const keyOutcome = await deps.asker.ask(caller.agent, keyPrompt);
  if (isOutcomePending(keyOutcome)) return refusal("The user did not answer in time; nothing was written.");
  if (keyOutcome.kind === "cancelled") return refusal(keyOutcome.reason);
  const keyInput = keyOutcome.reply.custom ?? keyOutcome.reply.selected[0];
  const key = readProjectKey(keyInput);
  if (!key.ok) return fromDomainError(key);

  // Step 3 re-check inside this Profile DB, then create + bind atomically.
  const clash = store.getProjectByKey(key.data);
  if (!clash.ok) return fromDomainError(clash);
  if (clash.data !== null) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Project key already exists in this Profile database.", field: "projectKey" } };
  }

  const binding = store.createAndBindProject(caller.sessionId, { name: name.data, projectKey: key.data });
  if (!binding.ok) return fromDomainError(binding);
  return { ok: true, project: projectOf(binding.data) };
}
