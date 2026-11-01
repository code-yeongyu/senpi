import type {
	ExtensionUIContext,
	QuestionCancelOrigin,
	QuestionRequest,
	QuestionResponse,
} from "../../core/extensions/types.ts";
import type { UiRequestChange } from "./snapshot-types.ts";
import { settledQuestionStatus, unansweredQuestionIds } from "./extension-ui-response.ts";
import type { RpcExtensionUIProgress, RpcExtensionUIResponse, RpcQuestionUiRequest } from "./rpc-types.ts";

type Options = Parameters<NonNullable<ExtensionUIContext["question"]>>[1];
type Pending = {
	frame: RpcQuestionUiRequest;
	progress: (draft: RpcExtensionUIProgress) => void;
	respond: (response: RpcExtensionUIResponse, beforeAnswer?: () => void) => boolean;
	cancel: () => void;
};
export const sessionQuestionBridges = new WeakMap<object, ConnectionQuestionBridge>();

export class ConnectionQuestionBridge {
	private readonly pending = new Map<string, Pending>();
	private readonly resolved = new Set<string>();
	private readonly output: (record: object) => void;
	private readonly changed: ((change?: UiRequestChange) => void) | undefined;
	constructor(output: (record: object) => void, changed?: (change?: UiRequestChange) => void) {
		this.output = output;
		this.changed = changed;
	}
	pendingQuestions(): RpcQuestionUiRequest[] {
		return [...this.pending.values()].map(({ frame }) => ({
			...frame,
			remainingMs: Math.max(0, frame.deadlineAtMs - Date.now()),
		}));
	}
	ask(request: QuestionRequest, opts?: Options): Promise<QuestionResponse> {
		const id = crypto.randomUUID();
		const askedAtMs = Date.now();
		const timeout = opts?.timeout ?? request.timeoutMs;
		const frame: RpcQuestionUiRequest = {
			type: "extension_ui_request",
			method: "question",
			id,
			requestId: request.requestId,
			toolCallId: request.requestId,
			waitForAnswer: request.waitForAnswer,
			questions: request.questions,
			timeout,
			askedAtMs,
			deadlineAtMs: askedAtMs + timeout,
			remainingMs: timeout,
		};
		return new Promise((resolve) => {
			let answers: QuestionResponse["answers"] = {};
			let comment: string | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let finished = false;
			const unanswered = () => unansweredQuestionIds(request.questions, answers);
			const finish = (
				status: QuestionResponse["status"],
				resolvedBy?: QuestionResponse["resolvedBy"],
				cancelOrigin?: QuestionCancelOrigin,
			) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", cancel);
				this.pending.delete(id);
				this.changed?.({
					type: "ui_request_settled",
					uiRequestId: id,
					disposition: status === "answered" || status === "comment-submitted" ? "answered" : "cancelled",
				});
				this.resolved.add(id);
				const result: QuestionResponse = {
					status,
					...(resolvedBy !== undefined ? { resolvedBy } : {}),
					answers,
					comment,
					unanswered: unanswered(),
					...(status === "timed_out" ? { autoResolvedAfterMs: Date.now() - askedAtMs } : {}),
					...(cancelOrigin !== undefined ? { cancelOrigin } : {}),
				};
				this.output({
					type: "question_resolved",
					id,
					requestId: frame.requestId,
					toolCallId: frame.toolCallId,
					outcome: status,
					...(result.resolvedBy !== undefined ? { resolvedBy: result.resolvedBy } : {}),
					answers,
					comment,
					unanswered: result.unanswered,
					deadlineAtMs: frame.deadlineAtMs,
				});
				resolve(result);
			};
			// An aborted dialog is a cancellation unless the aborting side resolved a
			// terminal status of its own: the ask-user extension's idle timer settles
			// the question `timed_out` and aborts with that status, and connections
			// must see the outcome the extension resolved (docs/rpc.md question).
			const cancel = () => {
				const reason: unknown = opts?.signal?.reason;
				finish(reason === "timed_out" ? "timed_out" : "cancelled");
			};
			const arm = () => {
				clearTimeout(timer);
				frame.deadlineAtMs = Date.now() + timeout;
				timer = setTimeout(() => finish("timed_out"), timeout);
			};
			this.pending.set(id, {
				frame,
				cancel,
				progress: (draft) => {
					if (draft.answers !== undefined) answers = draft.answers;
					if (draft.comment !== undefined) comment = draft.comment;
					arm();
					opts?.onProgress?.({ answers, comment });
					if (!finished)
						this.output({
							type: "question_updated",
							id,
							deadlineAtMs: frame.deadlineAtMs,
							remainingMs: Math.max(0, frame.deadlineAtMs - Date.now()),
						});
				},
				respond: (response, beforeAnswer) => {
					// The client's cancel is the user's; a closed connection or an abort is a lifecycle cancel.
					if ("cancelled" in response) {
						finish("cancelled", undefined, "user");
						return true;
					}
					if (!("answers" in response)) return false;
					answers = response.answers;
					comment = response.comment;
					const status = settledQuestionStatus(answers, comment);
					if (status === undefined) return false;
					// Only a tool-result answer is reported here. An async or resumed answer is delivered as a
					// user message, whose question-input release reports it; reporting both would count it twice.
					if (request.waitForAnswer && opts?.deliver !== "user-message") beforeAnswer?.();
					finish(status, "rpc_connection");
					return true;
				},
			});
			arm();
			this.changed?.({ type: "ui_request_pending", uiRequestId: id, method: "question", request: frame });
			this.output(frame);
			opts?.signal?.addEventListener("abort", cancel, { once: true });
			if (opts?.signal?.aborted) cancel();
		});
	}
	respond(
		response: RpcExtensionUIResponse,
		beforeAnswer?: () => void,
	): boolean | "question_incomplete" | "question_already_resolved" {
		const pending = this.pending.get(response.id);
		if (pending) return pending.respond(response, beforeAnswer) || "question_incomplete";
		return this.resolved.has(response.id) ? "question_already_resolved" : false;
	}
	progress(draft: RpcExtensionUIProgress): void {
		this.pending.get(draft.id)?.progress(draft);
	}
	cancelAll(): void {
		for (const pending of this.pending.values()) pending.cancel();
	}
}

export async function degradeQuestion(
	ui: Pick<ExtensionUIContext, "select" | "input">,
	request: QuestionRequest,
	opts?: Options,
): Promise<QuestionResponse> {
	const askedAtMs = Date.now();
	const answers: QuestionResponse["answers"] = {};
	const other = "Other (type an answer)";
	for (const question of request.questions) {
		// An abort ends the fallback: no dialog opens after it.
		if (opts?.signal?.aborted) break;
		const selected = await ui.select(
			question.question,
			[...question.options.map((option) => option.label), other],
			opts,
		);
		// A pick that lands after the abort is not an answer, whether a label or "Other".
		if (opts?.signal?.aborted) break;
		if (selected === other) {
			const text = await ui.input(question.question, undefined, opts);
			if (text?.trim()) answers[question.id] = { selected: [], text };
		} else if (selected !== undefined) answers[question.id] = { selected: [selected] };
		// Report the answers so far as the structured bridge does: an abort or the idle timer settles the
		// question from the extension's draft, before this fallback returns.
		if (answers[question.id] !== undefined) opts?.onProgress?.({ answers: { ...answers } });
	}
	const unanswered = unansweredQuestionIds(request.questions, answers);
	// An abort is never an answer. Like the structured bridge it settles cancelled, or timed_out when
	// the aborting side resolved that status; what the user had answered is kept as partial answers.
	if (opts?.signal?.aborted) {
		const timedOut = opts.signal.reason === "timed_out";
		return {
			status: timedOut ? "timed_out" : "cancelled",
			answers,
			unanswered,
			...(timedOut ? { autoResolvedAfterMs: Date.now() - askedAtMs } : {}),
		};
	}
	// No trailing "anything else?" prompt: a client without `question` shows every dialog as its own
	// blocking card, so an optional comment read as a new question from the agent
	// (sisyphuslabs/omo-desktop-app#4042). "Other" above still takes a typed answer per question.
	// A partial answer settles like the structured path: answered, with the rest listed unanswered.
	const status = settledQuestionStatus(answers, undefined);
	return {
		status: status ?? "cancelled",
		...(status !== undefined ? { resolvedBy: "rpc_connection" as const } : {}),
		answers,
		unanswered,
	};
}
