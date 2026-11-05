import { APP_NAME } from "../../../../config.ts";
import type { ExtensionAPI, ExtensionContext, QuestionCancelOrigin } from "../../types.ts";
import { pickVariant, TOOL_NAMES } from "./family.ts";
import { deliverQueuedQuestionOutcomes, getPendingQuestions } from "./registry.ts";
import { resumeDanglingQuestion } from "./resume.ts";
import { type AskUserState, createAskUserTool } from "./tool.ts";

export default function askUserExtension(pi: ExtensionAPI): void {
	pi.registerFlag("no-ask-user", {
		description: "Disable the built-in question tool.",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("answer", {
		description: "Open the pending question",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`/answer opens the pending question in the TUI; run ${APP_NAME} in TUI mode to use it.`,
					"info",
				);
				return;
			}
			// In TUI mode interactive-mode's text dispatch handles /answer first.
		},
	});
	const state: AskUserState = { timedOut: false, unavailable: false };
	let registered = false;
	const cancelPending = (
		ctx: ExtensionContext,
		origin: QuestionCancelOrigin,
		message: string,
		reportDetachedLoss = false,
	) => {
		for (const entry of getPendingQuestions(ctx.sessionManager.getSessionId()))
			entry.cancel(origin, message, reportDetachedLoss);
	};
	const sync = (ctx: ExtensionContext, model = ctx.model) => {
		const rest = pi.getActiveTools().filter((name) => !Object.values(TOOL_NAMES).includes(name));
		if (ctx.getAskUserSettings?.().enabled === false || pi.getFlag("no-ask-user") === true) {
			cancelPending(
				ctx,
				"ask_user_disabled",
				"The pending question was cancelled because ask-user is disabled.",
				true,
			);
			pi.setActiveTools(rest);
			return;
		}
		if (!registered) {
			pi.registerTool(createAskUserTool("codex", pi, state));
			pi.registerTool(createAskUserTool("claude", pi, state));
			registered = true;
		}
		pi.setActiveTools(state.unavailable ? rest : [...rest, TOOL_NAMES[pickVariant(model)]]);
	};
	pi.on("session_start", async (event, ctx) => {
		state.timedOut = false;
		state.unavailable = false;
		const sessionId = ctx.sessionManager.getSessionId();
		for (const entry of getPendingQuestions(sessionId)) entry.rebind(pi, ctx, state);
		deliverQueuedQuestionOutcomes(sessionId, pi, ctx);
		sync(ctx);
		for (const entry of getPendingQuestions(sessionId)) entry.reattach();
		// senpi#4827: publish a recovered question only after every startup handler returned, so its answer
		// cannot be admitted while later handlers still prepare the session. Never awaits the answer.
		// The runner skips it once this session is retired and reports its rejection.
		const recover = () => resumeDanglingQuestion(pi, event, ctx);
		if (ctx.afterSessionStart) ctx.afterSessionStart(recover);
		else void recover();
	});
	pi.on("model_select", async (event, ctx) => {
		sync(ctx, event.model);
	});
	pi.on("agent_end", async () => {
		state.timedOut = false;
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload") {
			for (const entry of getPendingQuestions(ctx.sessionManager.getSessionId())) entry.detach();
			return;
		}
		cancelPending(ctx, "session_closed", "The pending question was cancelled because the session closed.");
	});
}
