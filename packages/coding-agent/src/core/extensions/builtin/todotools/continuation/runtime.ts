import type { AssistantMessage } from "@mariozechner/pi-ai";
import { SettingsManager } from "../../../../settings-manager.js";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../../types.js";
import { emitBuiltinSystemMessageFailure, sendBuiltinUserMessage } from "../../system-messages.js";
import type { TodoItem } from "../state.js";
import { resolveContinuationConfig } from "./config.js";
import { buildContinuationPrompt, CONTINUATION_DIRECTIVE, countIncomplete } from "./prompt.js";

type ContinuationState = {
	reEntryFlag: boolean;
	chainCount: number;
	pendingDispatchAbortController?: AbortController;
};

type ContinuationDeps = {
	getCurrentTodos: () => TodoItem[];
};

const CLEAN_STOP_REASONS = new Set(["stop", "toolUse", "endTurn", "end_turn"]);
export const CONTINUATION_CHAIN_CAP = 10;
const IDLE_POLL_INTERVAL_MS = 50;
const IDLE_WAIT_TIMEOUT_MS = 10_000;

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") {
		return false;
	}

	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function getLastAssistantStopReason(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isAssistantMessage(message)) {
			continue;
		}

		return message.stopReason;
	}

	return undefined;
}

export function isContinuationFollowUpPrompt(prompt: string): boolean {
	return prompt.includes(CONTINUATION_DIRECTIVE);
}

export function isCleanStopReason(stopReason: string | undefined): boolean {
	return typeof stopReason === "string" && CLEAN_STOP_REASONS.has(stopReason);
}

function createInitialState(): ContinuationState {
	return {
		reEntryFlag: false,
		chainCount: 0,
	};
}

function abortPendingDispatch(state: ContinuationState): void {
	state.pendingDispatchAbortController?.abort();
	state.pendingDispatchAbortController = undefined;
}

function getSessionState(sessionStates: Map<string, ContinuationState>, sessionId: string): ContinuationState {
	const existingState = sessionStates.get(sessionId);
	if (existingState) {
		return existingState;
	}

	const nextState = createInitialState();
	sessionStates.set(sessionId, nextState);
	return nextState;
}

function getSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function isNonInteractiveContext(ctx: ExtensionContext): boolean {
	// ExtensionContext does not expose a dedicated mode flag. The documented
	// signal for print/RPC mode is `hasUI === false`.
	return !ctx.hasUI;
}

function shouldResetForSessionStart(event: SessionStartEvent): boolean {
	const reason = event.reason as string;
	return reason === "reload" || reason === "resume" || reason === "compact";
}

function reportContinuationError(pi: ExtensionAPI, ctx: ExtensionContext, error: unknown, prompt?: string): void {
	const message = error instanceof Error ? error.message : String(error);
	emitBuiltinSystemMessageFailure(pi, {
		route: "todotools.continuation",
		sessionId: getSessionId(ctx),
		kind: "user_message",
		content: prompt ?? "",
		errorMessage: message,
	});
	pi.events.emit("todotools:continuation_error", {
		sessionId: getSessionId(ctx),
		message,
	});
	if (ctx.hasUI) {
		ctx.ui.notify(`Todo continuation failed: ${message}`, "error");
		return;
	}
	process.stderr.write(`[todotools continuation] ${message}\n`);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function dispatchContinuationWhenIdle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	signal: AbortSignal,
): Promise<void> {
	const startedAt = Date.now();

	if (signal.aborted) {
		return;
	}

	while (Date.now() - startedAt < IDLE_WAIT_TIMEOUT_MS) {
		if (signal.aborted) {
			return;
		}

		if (ctx.isIdle()) {
			if (signal.aborted) {
				return;
			}

			sendBuiltinUserMessage(pi, "todotools.continuation", prompt, {
				sessionId: getSessionId(ctx),
			});
			return;
		}

		await wait(IDLE_POLL_INTERVAL_MS);

		if (signal.aborted) {
			return;
		}
	}

	console.warn("[todotools continuation] Timed out waiting for idle state; skipping auto-dispatch.");
}

export function installContinuation(pi: ExtensionAPI, deps: ContinuationDeps): void {
	const sessionStates = new Map<string, ContinuationState>();

	pi.registerFlag("disable-todo-continuation", {
		type: "boolean",
		default: false,
		description: "Disable todo continuation — automatic follow-up when incomplete todos remain in the list",
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionState = getSessionState(sessionStates, getSessionId(ctx));
		sessionState.reEntryFlag = false;
		if (!isContinuationFollowUpPrompt(event.prompt)) {
			sessionState.chainCount = 0;
			abortPendingDispatch(sessionState);
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (!shouldResetForSessionStart(event)) {
			return;
		}
		const sessionId = getSessionId(ctx);
		const existingState = sessionStates.get(sessionId);
		if (existingState) {
			abortPendingDispatch(existingState);
		}
		sessionStates.set(sessionId, createInitialState());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		const existingState = sessionStates.get(sessionId);
		if (existingState) {
			abortPendingDispatch(existingState);
		}
		sessionStates.delete(sessionId);
	});

	pi.on("agent_end", async (event, ctx) => {
		try {
			if (isNonInteractiveContext(ctx)) {
				return;
			}

			const stopReason = getLastAssistantStopReason(event.messages);
			if (!isCleanStopReason(stopReason)) {
				return;
			}

			const settingsManager = SettingsManager.create(ctx.cwd);
			const config = resolveContinuationConfig({
				globalSettings: settingsManager.getGlobalSettings() as Record<string, unknown>,
				projectSettings: settingsManager.getProjectSettings() as Record<string, unknown>,
				cliFlag: pi.getFlag("disable-todo-continuation"),
			});
			if (!config.enabled) {
				return;
			}

			const todos = deps.getCurrentTodos();
			if (countIncomplete(todos) === 0) {
				return;
			}

			const sessionId = getSessionId(ctx);
			const sessionState = getSessionState(sessionStates, sessionId);
			if (sessionState.reEntryFlag) {
				return;
			}
			if (sessionState.chainCount >= CONTINUATION_CHAIN_CAP) {
				return;
			}

			const prompt = buildContinuationPrompt(todos);
			abortPendingDispatch(sessionState);
			const pendingDispatchAbortController = new AbortController();
			sessionState.pendingDispatchAbortController = pendingDispatchAbortController;
			sessionState.reEntryFlag = true;
			sessionState.chainCount += 1;
			setTimeout(() => {
				void (async () => {
					try {
						await dispatchContinuationWhenIdle(pi, ctx, prompt, pendingDispatchAbortController.signal);
					} catch (error) {
						reportContinuationError(pi, ctx, error, prompt);
					} finally {
						const currentState = sessionStates.get(sessionId);
						if (currentState?.pendingDispatchAbortController === pendingDispatchAbortController) {
							currentState.pendingDispatchAbortController = undefined;
						}
					}
				})();
			}, 0);
		} catch (error) {
			reportContinuationError(pi, ctx, error);
		}
	});
}
