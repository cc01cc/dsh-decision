/**
 * Adapt the DSH user-questions service to the first-binding provider's asking
 * surface (PLAN-0778 T2.2, PLAN-0779 T2.1).
 *
 * Contract anchors (plans/PLAN-0769-DSD-decision-mvp/spec/decision-contract.md):
 * - line 79: the first call presents existing projects as a question card;
 * - line 80: cancelling or timing out writes no project and performs no decision operation.
 *
 * The service shapes are anchored in the installed runtime:
 * - ask(request): request = {questions, agent, signal}; the answer is
 *   {answers:[{id, selected, custom?}]}  (@deepseek-ai/dsh-user-questions 0.2.2-rc.1).
 * - askTimed(request, callId, timeoutMs): RESOLVES {pending:true,callId} when the
 *   timed wait elapses (lib/index.js:648-651) instead of throwing — so a timeout is
 *   a value, not an exception, and this adapter must not turn it into one.
 * - ask() THROWS UserQuestionError with code ASK_ABORTED when the signal aborts, and
 *   NO_PROVIDER when no answerer accepted the request (lib/index.js:707-717).
 *
 * Codes are matched structurally (no import of the runtime package) so this module
 * stays buildable and testable without the Host installed; the code strings are the
 * runtime's own.
 */

import type { AskOutcome, AskPrompt, AskReply, QuestionAsker } from "./first-binding.ts";

/** The subset of the user-questions service this adapter consumes. */
export interface UserQuestionsSurface {
  ask(request: UserQuestionsRequest): Promise<UserQuestionsAnswer>;
  askTimed(request: UserQuestionsRequest, callId: string, timeoutMs: number): Promise<UserQuestionsAnswer | TimedPending>;
}

export interface UserQuestionsRequest {
  readonly questions: readonly UserQuestionsQuestion[];
  readonly agent: unknown;
  readonly signal?: unknown;
}

export interface UserQuestionsQuestion {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
}

export interface UserQuestionsAnswerItem {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

export interface UserQuestionsAnswer {
  readonly answers: readonly UserQuestionsAnswerItem[];
}

/** Timeout result the service resolves with (lib/index.js:648-651). */
export interface TimedPending {
  readonly pending: true;
  readonly callId: string;
}

/** Cancellation / no-answerer codes this adapter maps to a closed refusal. */
export const ABORTED_CODE = "ASK_ABORTED";
export const NO_PROVIDER_CODE = "NO_PROVIDER";

const PROMPT_ID = "dsd-project";

function toQuestions(prompt: AskPrompt): UserQuestionsQuestion[] {
  return [{
    id: prompt.id,
    question: prompt.question,
    ...(prompt.options.length === 0 ? {} : { options: prompt.options.map((option) => ({ ...option })) }),
    multiSelect: prompt.multiSelect,
  }];
}

function promptOf(request: UserQuestionsRequest): AskPrompt {
  const first = request.questions[0];
  return {
    id: first?.id ?? PROMPT_ID,
    question: first?.question ?? "",
    options: first?.options ?? [],
    multiSelect: first?.multiSelect === true,
  };
}

function replyOf(answer: UserQuestionsAnswer, prompt: AskPrompt): AskReply {
  const item = answer.answers.find((entry) => entry.id === prompt.id) ?? answer.answers[0];
  if (item === undefined) return { selected: [] };
  return {
    selected: [...item.selected],
    ...(item.custom === undefined ? {} : { custom: item.custom }),
  };
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Map a thrown service error to a closed outcome.
 *
 * Cancellation and a missing answerer both refuse: either way no answer exists, so
 * the caller must stop without writing (contract line 80). Unknown errors are
 * rethrown rather than silenced — an unexplained failure must not look like a user
 * decision to skip the project.
 */
function cancelledOutcome(error: unknown): AskOutcome | undefined {
  const code = errorCodeOf(error);
  if (code === ABORTED_CODE) return { kind: "cancelled", reason: "The project question was cancelled." };
  if (code === NO_PROVIDER_CODE) return { kind: "cancelled", reason: "No user-question answerer is available; nothing was written." };
  return undefined;
}

export interface QuestionAskerOptions {
  /** Signal forwarded to the service so a cancelled step aborts the question. */
  readonly signal?: unknown;
  /** When set the prompt is windowed; the service's pending result writes nothing. */
  readonly timeoutMs?: number;
  /** Stable foreground call id for the windowed prompt. */
  readonly callId?: string;
}

/**
 * Build the first-binding QuestionAsker over the Host's user-questions service.
 *
 * ask() and askTimed() differ only in how the wait ends: a blocking wait either
 * answers or refuses, while a windowed wait may also return pending. The pending
 * branch is the service's resolved value and is passed through untouched so the
 * provider treats a timeout as a distinct, zero-write outcome.
 */
export function createQuestionAsker(
  surface: UserQuestionsSurface,
  options: QuestionAskerOptions = {},
): QuestionAsker {
  const ask = async (agent: unknown, prompt: AskPrompt): Promise<AskOutcome> => {
    try {
      const request: UserQuestionsRequest = {
        questions: toQuestions(prompt),
        agent,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const answer = await surface.ask(request);
      return { kind: "answered", reply: replyOf(answer, prompt) };
    } catch (error) {
      const mapped = cancelledOutcome(error);
      if (mapped !== undefined) return mapped;
      throw error;
    }
  };

  const askTimed = async (
    agent: unknown,
    prompt: AskPrompt,
    callId: string,
    callTimeoutMs?: number,
  ): Promise<AskOutcome> => {
    // task-14: the per-call window wins over the adapter default. The provider
    // passes the configured value on every call (first-binding -> askTimed), so a
    // caller that names its own window is never silently widened.
    const timeoutMs = callTimeoutMs ?? options.timeoutMs;
    if (timeoutMs === undefined) return ask(agent, prompt);
    try {
      const request: UserQuestionsRequest = {
        questions: toQuestions(prompt),
        agent,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const outcome = await surface.askTimed(request, options.callId ?? callId, timeoutMs);
      if (typeof outcome === "object" && outcome !== null && (outcome as TimedPending).pending === true) {
        return { kind: "pending", callId: (outcome as TimedPending).callId };
      }
      return { kind: "answered", reply: replyOf(outcome as UserQuestionsAnswer, prompt) };
    } catch (error) {
      const mapped = cancelledOutcome(error);
      if (mapped !== undefined) return mapped;
      throw error;
    }
  };

  return { ask, askTimed };
}
