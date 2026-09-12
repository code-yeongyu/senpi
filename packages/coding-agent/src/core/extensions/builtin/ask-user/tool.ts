import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../types.ts";
import { WAKE_SOURCE_STATE_EVENT, type WakeSourceStateEvent } from "../monitor-state-event.ts";
import { TOOL_NAMES } from "./family.ts";
import { formatResultDetails, formatResultText, formatUserMessage } from "./format.ts";
import { createPendingQuestion } from "./pending.ts";
import { getPendingQuestions, type QuestionDialogOptions, registerPendingQuestion } from "./registry.ts";
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
function result(
	variant: AskUserVariant,
	response: QuestionResponse,
	request: QuestionRequest,
	text?: string,
): Awaited<ReturnType<ToolDefinition["execute"]>> {
	return {
		content: [{ type: "text", text: text ?? formatResultText(variant, response, request.questions) }],
		details: formatResultDetails(variant, response, request.questions),
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
function deliverAnswer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: QuestionRequest,
	response: QuestionResponse,
): void {
	if (response.status === "cancelled") return;
	pi.sendUserMessage(formatUserMessage(response, request.requestId, request.questions), {
		deliverAs: ctx.isIdle() ? "followUp" : "steer",
	});
}
function emitWake(pi: ExtensionAPI, sessionId: string) {
	const entries = getPendingQuestions(sessionId).filter((e) => !e.request.waitForAnswer);
	const event: WakeSourceStateEvent = {
		source: "ask-user",
		activeCount: entries.length,
		items: entries.map((e) => ({
			id: e.request.requestId,
			description: e.request.questions.map((q) => q.header).join(", "),
		})),
	};
	pi.events.emit(WAKE_SOURCE_STATE_EVENT, event);
}
function startQuestion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: QuestionRequest,
	signal: AbortSignal | undefined,
	state: AskUserState,
) {
	const question = ctx.ui.question;
	if (!question) throw new Error("Question UI is unavailable");
	const sessionId = ctx.sessionManager.getSessionId();
	const controller = new AbortController();
	const completion = Promise.withResolvers<QuestionResponse>();
	let settled = false;
	let unregister = () => {};
	const finish = (response: QuestionResponse) => {
		if (settled) return;
		settled = true;
		if (response.status === "timed_out") state.timedOut = true;
		unregister();
		signal?.removeEventListener("abort", abort);
		if (!request.waitForAnswer) emitWake(pi, sessionId);
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
	const cancel = (message?: string) => {
		const response = pending.cancel();
		finish(message ? { ...response, comment: message } : response);
	};
	const abort = () => cancel();
	unregister = registerPendingQuestion(sessionId, { request, pending, completion: completion.promise, cancel });
	if (!request.waitForAnswer) emitWake(pi, sessionId);
	signal?.addEventListener("abort", abort, { once: true });
	let draft: { answers: QuestionResponse["answers"]; comment?: string } = { answers: {} };
	const opts: QuestionDialogOptions = {
		timeout: request.timeoutMs,
		signal: controller.signal,
		deliver: request.waitForAnswer ? "tool-result" : "user-message",
		hardDeadlineAtMs: Date.now() + 7_200_000,
		onProgress: (progress) => {
			draft = { ...draft, ...progress, answers: progress.answers ?? draft.answers };
			pending.touch(draft);
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
			pending.submit(response.answers, response.comment);
			if (pending.state === "pending") pending.cancel();
		} else pending.cancel(response.status);
		finish(response);
	};
	const fail = (error: unknown) => {
		if (settled) return;
		const message = `Question UI failed: ${error instanceof Error ? error.message : String(error)}`;
		cancel(message);
		ctx.ui.notify(message, "error");
	};
	if (signal?.aborted) abort();
	else {
		try {
			question.call(ctx.ui, request, opts).then(accept, fail);
		} catch (error: unknown) {
			fail(error);
		}
	}
	if (!request.waitForAnswer) void completion.promise.then((response) => deliverAnswer(pi, ctx, request, response));
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
		description: `${opener} Set ${flag} true to pause here until the user answers (the answer returns as this tool's result, or a timeout result after 30 idle minutes); set ${flag} false to keep working while the question stays open (the answer arrives later as a user message). Use it only when the answer materially changes the work; if it returns no answers, continue with best judgment instead of asking again. Never use it for permission requests; ask those directly in your message. Unavailable to subagents.${variant === "claude" ? " Users will always be able to type a free-text answer or one comment covering everything; do not add an Other option." : ""} Call this tool directly, never from inside an eval cell (a cell that waits on the user would hold the kernel).`,
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
				return { content: [{ type: "text", text: error.message }], details: { status: "unavailable" } };
			}
			const unavailable: QuestionResponse = {
				status: "unavailable",
				answers: {},
				unanswered: request.questions.map((q) => q.id),
			};
			if (state.timedOut) return result(variant, unavailable, request, REASK);
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
				return result(variant, unavailable, request);
			}
			const completion = startQuestion(pi, ctx, request, signal, state);
			if (!request.waitForAnswer)
				return {
					content: [{ type: "text", text: "Question accepted; the answer will arrive as a user message." }],
					details: { accepted: true, requestId: request.requestId, status: "pending" },
				};
			const response = await completion;
			return result(
				variant,
				response,
				request,
				response.status === "cancelled" && response.comment ? response.comment : undefined,
			);
		},
		renderCall,
		renderResult,
	};
}
