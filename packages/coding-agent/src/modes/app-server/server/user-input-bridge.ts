import { createPendingQuestion, type PendingQuestion } from "../../../core/extensions/builtin/ask-user/pending.ts";
import type { QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";
import type { RequestId } from "../protocol/index.ts";
import {
	isRecord,
	readUserInputResult,
	toDraft,
	type UserInputDraft,
	type UserInputOptions,
	type UserInputOutboundMessage,
	type UserInputRequest,
	type UserInputResponse,
} from "./user-input-types.ts";

type PendingInput = {
	threadId: string;
	canonical: QuestionRequest;
	request: UserInputRequest;
	state: PendingQuestion;
	draft: UserInputDraft;
	onProgress: NonNullable<UserInputOptions>["onProgress"];
	removeAbort: () => void;
	resolve: (response: QuestionResponse) => void;
};

export class UserInputBridge {
	private nextId = 0;
	private readonly pending = new Map<RequestId, PendingInput>();
	private readonly send: (threadId: string, message: UserInputOutboundMessage) => number;

	constructor(send: (threadId: string, message: UserInputOutboundMessage) => number) {
		this.send = send;
	}
	get pendingCount(): number {
		return this.pending.size;
	}

	requestUserInput(
		threadId: string,
		turnId: string,
		itemId: string,
		canonical: QuestionRequest,
		opts?: UserInputOptions,
	): Promise<QuestionResponse> {
		// ApprovalBridge owns numeric ids; this namespace cannot collide with them.
		const id = `user-input-${this.nextId++}`;
		const request: UserInputRequest = {
			id,
			method: "item/tool/requestUserInput",
			params: {
				threadId,
				turnId,
				itemId,
				autoResolutionMs: null,
				timeoutMs: opts?.timeout ?? canonical.timeoutMs,
				waitForAnswer: canonical.waitForAnswer,
				questions: canonical.questions.map((question) => ({
					...question,
					isOther: true,
					isSecret: false,
					options: question.options.length
						? question.options.map((option) => ({ label: option.label, description: option.description ?? "" }))
						: null,
				})),
			},
		};
		return new Promise((resolve) => {
			const state = createPendingQuestion({
				request: canonical,
				now: Date.now,
				idleTimeoutMs: request.params.timeoutMs,
				onTimeout: (response) => this.finish(id, response),
			});
			const abort = () => this.finish(id, state.cancel());
			this.pending.set(id, {
				threadId,
				canonical,
				request,
				state,
				draft: { answers: {} },
				resolve,
				onProgress: opts?.onProgress,
				removeAbort: () => opts?.signal?.removeEventListener("abort", abort),
			});
			if (opts?.signal?.aborted) {
				abort();
				return;
			}
			opts?.signal?.addEventListener("abort", abort, { once: true });
			if (state.result) {
				this.finish(id, state.result);
				return;
			}
			if (this.send(threadId, request) === 0) this.finish(id, state.cancel("unavailable"));
		});
	}

	resolveResponse(response: UserInputResponse): boolean {
		const pending = this.pending.get(response.id);
		if (!pending) return false;
		if (response.error !== undefined) {
			this.finish(response.id, pending.state.cancel());
			return true;
		}
		const result = readUserInputResult(response.result);
		const draft = toDraft(pending.canonical, result);
		pending.state.touch(draft);
		if (result.cancelled) {
			this.finish(response.id, pending.state.cancel());
			return true;
		}
		const submitted = pending.state.submit(draft.answers, draft.comment);
		if (submitted) this.finish(response.id, submitted);
		else {
			// A submit may intentionally leave questions unanswered; it is not a draft.
			const cancelled = pending.state.cancel();
			const hasAnswer = Object.values(draft.answers).some(
				(answer) => answer.selected.length > 0 || answer.text?.trim(),
			);
			this.finish(response.id, hasAnswer ? { ...cancelled, status: "answered" } : cancelled);
		}
		return true;
	}

	progress(params: unknown): boolean {
		if (!isRecord(params) || (typeof params.requestId !== "string" && typeof params.requestId !== "number"))
			return false;
		const pending = this.pending.get(params.requestId);
		if (!pending) return false;
		const result = readUserInputResult(params);
		const next = toDraft(pending.canonical, result);
		pending.draft = {
			answers: params.answers === undefined ? pending.draft.answers : next.answers,
			comment: params.comment === undefined ? pending.draft.comment : next.comment,
		};
		pending.state.touch(pending.draft);
		pending.onProgress?.(pending.draft);
		return true;
	}

	replayPendingForThread(threadId: string): number {
		let replayed = 0;
		for (const pending of this.pending.values()) {
			if (pending.threadId !== threadId) continue;
			this.send(threadId, pending.request);
			replayed++;
		}
		return replayed;
	}
	cancelPendingForThread(threadId: string): number {
		let cancelled = 0;
		for (const [id, pending] of this.pending) {
			if (pending.threadId !== threadId) continue;
			this.finish(id, pending.state.cancel());
			cancelled++;
		}
		return cancelled;
	}
	private finish(id: RequestId, response: QuestionResponse): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.removeAbort();
		// Answers never enter diagnostics; only the correlation id leaves this path.
		this.send(pending.threadId, {
			method: "serverRequest/resolved",
			params: { threadId: pending.threadId, requestId: id },
		});
		pending.resolve(response);
	}
}
