import type { ExtensionUIContext, QuestionRequest, QuestionResponse } from "../../core/extensions/types.ts";
import type { RpcExtensionUIProgress, RpcExtensionUIResponse, RpcQuestionUiRequest } from "./rpc-types.ts";

type Options = Parameters<NonNullable<ExtensionUIContext["question"]>>[1];
type Pending = {
	frame: RpcQuestionUiRequest;
	progress: (draft: RpcExtensionUIProgress) => void;
	respond: (response: RpcExtensionUIResponse) => boolean;
	cancel: () => void;
};
export const sessionQuestionBridges = new WeakMap<object, ConnectionQuestionBridge>();

export class ConnectionQuestionBridge {
	private readonly pending = new Map<string, Pending>();
	private readonly resolved = new Set<string>();
	private readonly output: (record: object) => void;
	constructor(output: (record: object) => void) {
		this.output = output;
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
			const unanswered = () =>
				request.questions
					.filter((q) => !answers[q.id]?.selected.length && !answers[q.id]?.text?.trim())
					.map((q) => q.id);
			const finish = (status: QuestionResponse["status"]) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", cancel);
				this.pending.delete(id);
				this.resolved.add(id);
				const result: QuestionResponse = {
					status,
					answers,
					comment,
					unanswered: unanswered(),
					...(status === "timed_out" ? { autoResolvedAfterMs: Date.now() - askedAtMs } : {}),
				};
				this.output({
					type: "question_resolved",
					id,
					requestId: frame.requestId,
					toolCallId: frame.toolCallId,
					outcome: status,
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
				respond: (response) => {
					if ("cancelled" in response) {
						cancel();
						return true;
					}
					if (!("answers" in response)) return false;
					answers = response.answers;
					comment = response.comment;
					if (!comment?.trim() && Object.keys(answers).length === 0) return false;
					finish(comment?.trim() ? "comment-submitted" : "answered");
					return true;
				},
			});
			arm();
			this.output(frame);
			opts?.signal?.addEventListener("abort", cancel, { once: true });
			if (opts?.signal?.aborted) cancel();
		});
	}
	respond(response: RpcExtensionUIResponse): boolean | "question_incomplete" | "question_already_resolved" {
		const pending = this.pending.get(response.id);
		if (pending) return pending.respond(response) || "question_incomplete";
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
	const answers: QuestionResponse["answers"] = {};
	const other = "Other (type an answer)";
	for (const question of request.questions) {
		const selected = await ui.select(
			question.question,
			[...question.options.map((option) => option.label), other],
			opts,
		);
		if (selected === other) {
			const text = await ui.input(question.question, undefined, opts);
			if (text?.trim()) answers[question.id] = { selected: [], text };
		} else if (selected !== undefined) answers[question.id] = { selected: [selected] };
	}
	const comment = await ui.input("Anything else? (optional)", undefined, opts);
	const unanswered = request.questions.filter((q) => !answers[q.id]).map((q) => q.id);
	return {
		status: comment?.trim() ? "comment-submitted" : unanswered.length ? "cancelled" : "answered",
		answers,
		comment,
		unanswered,
	};
}
