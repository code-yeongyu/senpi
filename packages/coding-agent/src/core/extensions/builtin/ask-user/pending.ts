// TODO(t1-merge): import from ./schema.ts
export type QuestionOption = {
	label: string;
	description?: string;
};

export type QuestionItem = {
	id: string;
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect: boolean;
};

export type QuestionRequest = {
	requestId: string;
	questions: QuestionItem[];
	waitForAnswer: boolean;
	timeoutMs: number;
};

export type QuestionAnswer = {
	selected: string[];
	text?: string;
};

export type QuestionAnswers = Record<string, QuestionAnswer>;

export type QuestionResponseStatus =
	| "answered"
	| "comment-submitted"
	| "timed_out"
	| "cancelled"
	| "orphaned-after-restart"
	| "unavailable";

export type QuestionResponse = {
	status: QuestionResponseStatus;
	answers: QuestionAnswers;
	comment?: string;
	unanswered: string[];
	autoResolvedAfterMs?: number;
};

export type QuestionDraft = {
	answers: QuestionAnswers;
	comment?: string;
};

export type CancelReason = "cancelled" | "orphaned-after-restart" | "unavailable";

const DEFAULT_HARD_CAP_MS = 7_200_000;

export type PendingTimerHandle = ReturnType<typeof setTimeout>;

export type PendingQuestionOptions = {
	request: QuestionRequest;
	now: () => number;
	idleTimeoutMs: number;
	hardCapMs?: number;
	onTimeout?: (result: QuestionResponse) => void;
	setTimeout?: (handler: () => void, delayMs: number) => PendingTimerHandle;
	clearTimeout?: (handle: PendingTimerHandle) => void;
};

export type PendingQuestionState = "pending" | QuestionResponseStatus;

export type PendingQuestion = {
	touch(draft?: QuestionDraft): void;
	submit(answers: QuestionAnswers, comment?: string): QuestionResponse | false;
	cancel(reason?: CancelReason): QuestionResponse;
	timeout(): QuestionResponse;
	readonly state: PendingQuestionState;
	readonly deadlineAtMs: number;
	remainingMs(now: number): number;
	readonly result: QuestionResponse | undefined;
};

function copyAnswers(answers: QuestionAnswers): QuestionAnswers {
	const copied: QuestionAnswers = {};
	for (const [id, answer] of Object.entries(answers)) {
		copied[id] = {
			selected: [...answer.selected],
			...(answer.text !== undefined ? { text: answer.text } : {}),
		};
	}
	return copied;
}

function hasAnswer(answer: QuestionAnswer | undefined): boolean {
	if (answer === undefined) return false;
	if (answer.selected.length > 0) return true;
	return answer.text !== undefined && answer.text.trim() !== "";
}

function unansweredIds(request: QuestionRequest, answers: QuestionAnswers): string[] {
	const unanswered: string[] = [];
	for (const question of request.questions) {
		if (!hasAnswer(answers[question.id])) unanswered.push(question.id);
	}
	return unanswered;
}

function isCommentPresent(comment: string | undefined): comment is string {
	return comment !== undefined && comment.trim() !== "";
}

function buildResponse(
	status: QuestionResponseStatus,
	request: QuestionRequest,
	answers: QuestionAnswers,
	comment: string | undefined,
	autoResolvedAfterMs?: number,
): QuestionResponse {
	return {
		status,
		answers: copyAnswers(answers),
		...(isCommentPresent(comment) ? { comment } : {}),
		unanswered: unansweredIds(request, answers),
		...(autoResolvedAfterMs !== undefined ? { autoResolvedAfterMs } : {}),
	};
}

export function createPendingQuestion(options: PendingQuestionOptions): PendingQuestion {
	const createdAtMs = options.now();
	const hardCapMs = options.hardCapMs ?? DEFAULT_HARD_CAP_MS;
	const hardDeadlineAtMs = createdAtMs + hardCapMs;
	const schedule: NonNullable<PendingQuestionOptions["setTimeout"]> =
		options.setTimeout ?? ((handler, delayMs) => setTimeout(handler, delayMs));
	const unsched: NonNullable<PendingQuestionOptions["clearTimeout"]> = options.clearTimeout ?? clearTimeout;

	let deadlineAtMs = Math.min(createdAtMs + options.idleTimeoutMs, hardDeadlineAtMs);
	let draftAnswers: QuestionAnswers = {};
	let draftComment: string | undefined;
	let terminal: QuestionResponse | undefined;
	let timer: PendingTimerHandle | undefined;

	const disarm = () => {
		if (timer === undefined) return;
		unsched(timer);
		timer = undefined;
	};

	const settle = (response: QuestionResponse, notifyTimeout: boolean): QuestionResponse => {
		if (terminal !== undefined) return terminal;
		terminal = response;
		disarm();
		if (notifyTimeout) options.onTimeout?.(response);
		return response;
	};

	const fireTimeout = (): QuestionResponse => {
		const elapsedMs = Math.max(0, options.now() - createdAtMs);
		return settle(buildResponse("timed_out", options.request, draftAnswers, draftComment, elapsedMs), true);
	};

	const arm = () => {
		disarm();
		if (terminal !== undefined) return;
		const delayMs = deadlineAtMs - options.now();
		if (delayMs <= 0) {
			fireTimeout();
			return;
		}
		timer = schedule(() => {
			timer = undefined;
			fireTimeout();
		}, delayMs);
	};

	arm();

	return {
		touch(draft) {
			if (terminal !== undefined) return;
			if (draft !== undefined) {
				draftAnswers = copyAnswers(draft.answers);
				draftComment = draft.comment;
			}
			deadlineAtMs = Math.min(options.now() + options.idleTimeoutMs, hardDeadlineAtMs);
			arm();
		},
		submit(answers, comment) {
			if (terminal !== undefined) return terminal;
			if (isCommentPresent(comment)) {
				return settle(buildResponse("comment-submitted", options.request, answers, comment), false);
			}
			if (unansweredIds(options.request, answers).length === 0) {
				return settle(buildResponse("answered", options.request, answers, comment), false);
			}
			if (Object.keys(answers).length > 0) {
				return settle(buildResponse("answered", options.request, answers, comment), false);
			}
			return false;
		},
		cancel(reason = "cancelled") {
			if (terminal !== undefined) return terminal;
			return settle(buildResponse(reason, options.request, draftAnswers, draftComment), false);
		},
		timeout() {
			if (terminal !== undefined) return terminal;
			return fireTimeout();
		},
		get state() {
			return terminal?.status ?? "pending";
		},
		get deadlineAtMs() {
			return deadlineAtMs;
		},
		remainingMs(now) {
			return Math.max(0, deadlineAtMs - now);
		},
		get result() {
			return terminal;
		},
	};
}
