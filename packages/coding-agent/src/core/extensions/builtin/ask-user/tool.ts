import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../types.ts";
import { WAKE_SOURCE_STATE_EVENT, type WakeSourceStateEvent } from "../monitor-state-event.ts";
import { TOOL_NAMES } from "./family.ts";
import { formatGatedCancellation, formatModelAnswer, formatResultDetails, formatUserMessage } from "./format.ts";
import {
	ASK_USER_ASKED_EVENT,
	ASK_USER_QUESTION_ENTRY,
	ASK_USER_SETTLEMENT_ENTRY,
	type AskUserAskedEvent,
	type AskUserQuestionEntry,
	emitAskUserClosed,
	emitAskUserNotification,
} from "./notify.ts";
import { createPendingQuestion } from "./pending.ts";
import {
	getPendingQuestions,
	type QuestionDialogOptions,
	queueQuestionOutcome,
	registerPendingQuestion,
} from "./registry.ts";
import { renderCall, renderResult } from "./render.ts";
import {
	AskUserSchemaError,
	type AskUserVariant,
	CLAUDE_PARAMS,
	CODEX_PARAMS,
	type QuestionRequest,
	type QuestionResponse,
	toCanonical,
} from "./schema.ts";

export interface AskUserState {
	timedOut: boolean;
	unavailable: boolean;
}
const REASK = "The user did not answer the previous question this turn; continue without asking again.";
const REASK_REQUIRED =
	"The user did not answer the previous question this turn, so this one gets no answer either. No answer: do not take the action it gates. Keep that action pending and end the turn.";
function result(
	variant: AskUserVariant,
	response: QuestionResponse,
	request: QuestionRequest,
	text?: string,
): Awaited<ReturnType<ToolDefinition["execute"]>> {
	return {
		content: [
			{
				type: "text",
				text:
					text ??
					formatModelAnswer(response, request.requestId, request.questions, request.required === true).text,
			},
		],
		details: formatResultDetails(variant, response, request.requestId, request.questions, request.required === true),
	};
}
/**
 * Deliver a settled async answer as one framed user message. The extension owns
 * this so every surface (interactive TUI, RPC, app-server) only has to RESOLVE
 * the question; a surface that delivered on its own would send it twice. It
 * steers into a running turn and follows up when idle - a follow-up always
 * triggers a turn, which is what wakes the model after a timeout. A cancelled
 * question stays silent: it was dismissed, superseded, or aborted.
 */
export function deliverAnswer(
	pi: Pick<ExtensionAPI, "sendUserMessage" | "events">,
	ctx: ExtensionContext,
	request: QuestionRequest,
	response: QuestionResponse,
	variant: "codex" | "claude",
): void {
	if (response.status === "cancelled") return;
	pi.sendUserMessage(formatUserMessage(response, request.requestId, request.questions, request.required === true), {
		deliverAs: ctx.isIdle() ? "followUp" : "steer",
	});
	void emitAskUserNotification(pi, ctx, request, response, variant);
}
function emitWake(pi: Pick<ExtensionAPI, "events">, sessionId: string) {
	const entries = getPendingQuestions(sessionId).filter((e) => !e.request.waitForAnswer);
	const event: WakeSourceStateEvent = {
		source: "ask-user",
		activeCount: entries.length,
		items: entries.map((e) => ({
			id: e.request.requestId,
			deadlineAtMs: e.pending.deadlineAtMs,
			description: e.request.questions.map((q) => q.header).join(", "),
		})),
	};
	pi.events.emit(WAKE_SOURCE_STATE_EVENT, event);
}
export function startQuestion(
	initialPi: Pick<ExtensionAPI, "sendUserMessage" | "events" | "appendEntry">,
	initialCtx: ExtensionContext,
	request: QuestionRequest,
	signal: AbortSignal | undefined,
	initialState: AskUserState,
	variant: "codex" | "claude",
	{ resuming = false }: { resuming?: boolean } = {},
) {
	let pi = initialPi;
	let ctx = initialCtx;
	let state = initialState;
	let notify = ctx.ui.notify.bind(ctx.ui);
	const question = ctx.ui.question;
	if (!question && !resuming) throw new Error("Question UI is unavailable");
	const sessionId = ctx.sessionManager.getSessionId();
	const existing = getPendingQuestions(sessionId).find((entry) => entry.request.requestId === request.requestId);
	if (existing) return existing.completion;
	const orphaned = (): QuestionResponse => ({
		status: "orphaned-after-restart",
		answers: {},
		unanswered: request.questions.map((question) => question.id),
	});
	let controller = new AbortController();
	let attached = true;
	let ownerBound = true;
	let generation = 0;
	const completion = Promise.withResolvers<QuestionResponse>();
	let settled = false;
	let unregister = () => {};
	const publish = (
		ownerPi: Pick<ExtensionAPI, "sendUserMessage" | "events" | "appendEntry">,
		ownerCtx: ExtensionContext,
		response: QuestionResponse,
	) => {
		emitAskUserClosed(ownerPi, request.requestId, response);
		if (!request.waitForAnswer)
			ownerPi.appendEntry(ASK_USER_SETTLEMENT_ENTRY, {
				requestId: request.requestId,
				status: response.status,
			});
		if (!request.waitForAnswer || resuming) deliverAnswer(ownerPi, ownerCtx, request, response, variant);
	};
	const finish = (response: QuestionResponse) => {
		if (settled) return;
		settled = true;
		if (response.status === "timed_out") state.timedOut = true;
		unregister();
		signal?.removeEventListener("abort", abort);
		if (!request.waitForAnswer) emitWake(pi, sessionId);
		pi.events.emit("herdr:blocked", { active: false, id: request.requestId });
		if (ownerBound) publish(pi, ctx, response);
		else {
			// The old API is invalid after reload. End the request at its deadline,
			// notify the still-live UI, and deliver through the next bound runner.
			queueQuestionOutcome(sessionId, (nextPi, nextCtx) => publish(nextPi, nextCtx, response));
			if (response.status !== "cancelled")
				notify(
					`Question ${request.requestId} ended (${response.status}) while reload was incomplete. Its outcome will reach the model when the session starts again.`,
					"error",
				);
		}
		completion.resolve(response);
		// This extension owns the authoritative idle timer (pending.ts), so a UI
		// bridge that is still waiting learns the outcome only from this abort.
		// Carry the resolved status as the abort reason: a bare abort reads as a
		// dismissal, and the RPC bridge would broadcast a timeout as "cancelled".
		const abortReason: QuestionResponse["status"] = response.status;
		controller.abort(abortReason);
	};
	const pending = createPendingQuestion({
		request,
		now: Date.now,
		idleTimeoutMs: request.timeoutMs,
		onTimeout: finish,
	});
	const cancel = (message?: string, reportDetachedLoss = false) => {
		const lost = !attached && reportDetachedLoss;
		const response = pending.cancel(lost ? "orphaned-after-restart" : "cancelled");
		finish(message ? { ...response, comment: message } : response);
		if (lost) notify(message ?? "The pending question could not be restored.", "error");
	};
	const abort = () => cancel();
	unregister = registerPendingQuestion(sessionId, {
		request,
		pending,
		completion: completion.promise,
		cancel,
		detach() {
			if (!attached || settled) return;
			attached = false;
			ownerBound = false;
			generation++;
			controller.abort("reload");
		},
		rebind(nextPi, nextCtx, nextState) {
			pi = nextPi;
			ctx = nextCtx;
			state = nextState;
			notify = ctx.ui.notify.bind(ctx.ui);
			ownerBound = true;
		},
		reattach() {
			if (attached || settled) return;
			attached = true;
			controller = new AbortController();
			attach();
		},
	});
	pi.appendEntry<AskUserQuestionEntry>(ASK_USER_QUESTION_ENTRY, {
		requestId: request.requestId,
		headers: request.questions.map((question) => question.header),
	});
	if (!request.waitForAnswer) emitWake(pi, sessionId);
	pi.events.emit(ASK_USER_ASKED_EVENT, { ctx, request, variant } satisfies AskUserAskedEvent);
	const first = request.questions[0];
	pi.events.emit("herdr:blocked", {
		active: true,
		label: first ? `${first.header} — ${first.question}` : "Question",
		id: request.requestId,
	});
	signal?.addEventListener("abort", abort, { once: true });
	let draft: { answers: QuestionResponse["answers"]; comment?: string } = { answers: {} };
	const opts: QuestionDialogOptions = {
		timeout: request.timeoutMs,
		signal: controller.signal,
		deliver: request.waitForAnswer ? "tool-result" : "user-message",
		hardDeadlineAtMs: Date.now() + 7_200_000,
		getDeadlineAtMs: () => pending.deadlineAtMs,
		onProgress: (progress) => {
			draft = { ...draft, ...progress, answers: progress.answers ?? draft.answers };
			pending.touch(draft);
			if (!request.waitForAnswer) emitWake(pi, sessionId);
		},
	};
	const accept = (response: QuestionResponse) => {
		if (settled) return;
		pending.touch({ answers: response.answers, comment: response.comment });
		if (response.status === "timed_out") {
			finish(response);
			pending.timeout();
			return;
		}
		if (response.status === "answered" || response.status === "comment-submitted") {
			// The UI owns partial submission validation; retain its response verbatim.
			pending.submit(response.answers, response.comment, response.resolvedBy);
			if (pending.state === "pending") pending.cancel();
		} else pending.cancel(response.status);
		finish(response);
	};
	const fail = (error: unknown) => {
		if (settled) return;
		const message = `Question UI failed: ${error instanceof Error ? error.message : String(error)}`;
		if (resuming || generation > 0) {
			accept({ ...orphaned(), comment: message });
			ctx.ui.notify(message, "error");
			return;
		}
		cancel(message);
		ctx.ui.notify(message, "error");
	};
	const attach = () => {
		const currentGeneration = generation;
		const currentQuestion = ctx.ui.question;
		if (!currentQuestion) {
			accept(orphaned());
			if (generation > 0)
				ctx.ui.notify("The pending question could not be restored: question UI is unavailable.", "error");
			return;
		}
		try {
			currentQuestion
				.call(ctx.ui, request, {
					...opts,
					signal: controller.signal,
					// The first attachment owns the whole budget; a re-attachment inherits what the
					// authoritative idle timer has left, so a reload cannot hand the question a fresh one.
					timeout: currentGeneration === 0 ? request.timeoutMs : pending.remainingMs(Date.now()),
					initialDraft: draft,
					onProgress: (progress) => {
						if (attached && generation === currentGeneration) opts.onProgress(progress);
					},
				})
				.then(
					(response) => {
						if (attached && generation === currentGeneration) accept(response);
					},
					(error: unknown) => {
						if (attached && generation === currentGeneration) fail(error);
					},
				);
		} catch (error: unknown) {
			fail(error);
		}
	};
	if (signal?.aborted) abort();
	else attach();
	return completion.promise;
}
export function createAskUserTool(variant: AskUserVariant, pi: ExtensionAPI, state: AskUserState): ToolDefinition {
	const flag = variant === "codex" ? "wait_for_answer" : "waitForAnswer";
	const opener =
		variant === "codex"
			? "Request user input for one to three short questions."
			: "Ask the user one to four concise questions.";
	return {
		name: TOOL_NAMES[variant],
		label: "Ask user",
		exposure: "direct",
		allowLazyActivation: false,
		parameters: variant === "codex" ? CODEX_PARAMS : CLAUDE_PARAMS,
		promptSnippet: "Ask a material question, explicitly choosing whether to wait or receive the answer later.",
		description: `${opener} Set ${flag} true to pause here until the user answers (the answer returns as this tool's result, or a timeout result after 30 idle minutes); set ${flag} false to keep working while the question stays open (the answer arrives later as a user message). Use it only when the answer materially changes the work; if it returns no answers, continue with best judgment instead of asking again, unless you set required true because the answer decides whether you take an action: then no answer means do not take it. Never use it for permission requests; ask those directly in your message. Unavailable to subagents.${variant === "claude" ? " Users will always be able to type a free-text answer or one comment covering everything; do not add an Other option." : ""} Call this tool directly, never from inside an eval cell (a cell that waits on the user would hold the kernel).`,
		prepareArguments(args) {
			toCanonical(variant, args);
			return args;
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			let request: QuestionRequest;
			try {
				request = toCanonical(variant, params, {
					requestId: toolCallId,
					timeoutMs: (ctx.getAskUserSettings?.().timeoutMinutes ?? 30) * 60_000,
				});
			} catch (error: unknown) {
				if (!(error instanceof AskUserSchemaError)) throw error;
				emitAskUserClosed(pi, toolCallId, { status: "unavailable" });
				return { content: [{ type: "text", text: error.message }], details: { status: "unavailable" } };
			}
			const unavailable: QuestionResponse = {
				status: "unavailable",
				answers: {},
				unanswered: request.questions.map((q) => q.id),
			};
			if (state.timedOut) {
				emitAskUserClosed(pi, request.requestId, unavailable);
				return result(variant, unavailable, request, request.required === true ? REASK_REQUIRED : REASK);
			}
			if (
				state.unavailable ||
				ctx.getAskUserSettings?.().enabled === false ||
				pi.getFlag("no-ask-user") === true ||
				ctx.mode === "print" ||
				ctx.mode === "json" ||
				!ctx.ui.question
			) {
				state.unavailable = true;
				pi.setActiveTools(pi.getActiveTools().filter((name) => !Object.values(TOOL_NAMES).includes(name)));
				emitAskUserClosed(pi, request.requestId, unavailable);
				return result(variant, unavailable, request);
			}
			const completion = startQuestion(pi, ctx, request, signal, state, variant);
			if (!request.waitForAnswer)
				return {
					content: [{ type: "text", text: "Question accepted; the answer will arrive as a user message." }],
					details: { accepted: true, requestId: request.requestId, status: "pending" },
				};
			const response = await completion;
			if (response.status !== "cancelled") {
				void emitAskUserNotification(pi, ctx, request, response, variant);
			}
			return result(
				variant,
				response,
				request,
				response.status === "cancelled" && response.comment
					? request.required === true
						? formatGatedCancellation(response.comment, response, request.requestId, request.questions)
						: response.comment
					: undefined,
			);
		},
		renderCall,
		renderResult,
	};
}
