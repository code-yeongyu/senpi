import type { AssistantMessage } from "@mariozechner/pi-ai";
import { SettingsManager } from "../../../../settings-manager.js";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../../types.js";
import type { TodoItem } from "../state.js";
import { resolveContinuationConfig } from "./config.js";
import { buildContinuationPrompt, CONTINUATION_DIRECTIVE, countIncomplete } from "./prompt.js";

type ContinuationState = {
	reEntryFlag: boolean;
	chainCount: number;
};

type ContinuationDeps = {
	getCurrentTodos: () => TodoItem[];
};

const CLEAN_STOP_REASONS = new Set(["stop", "toolUse", "endTurn", "end_turn"]);
export const CONTINUATION_CHAIN_CAP = 10;

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

function shouldResetForSessionStart(event: SessionStartEvent): boolean {
	const reason = event.reason as string;
	return reason === "reload" || reason === "resume" || reason === "compact";
}

function reportContinuationError(pi: ExtensionAPI, ctx: ExtensionContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
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
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (!shouldResetForSessionStart(event)) {
			return;
		}
		sessionStates.set(getSessionId(ctx), createInitialState());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionStates.delete(getSessionId(ctx));
	});

	pi.on("agent_end", async (event, ctx) => {
		try {
			if (!ctx.hasUI) {
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

			const sessionState = getSessionState(sessionStates, getSessionId(ctx));
			if (sessionState.reEntryFlag) {
				return;
			}
			if (sessionState.chainCount >= CONTINUATION_CHAIN_CAP) {
				return;
			}

			sessionState.reEntryFlag = true;
			sessionState.chainCount += 1;
			await Promise.resolve(pi.sendUserMessage(buildContinuationPrompt(todos), { deliverAs: "followUp" }));
		} catch (error) {
			reportContinuationError(pi, ctx, error);
		}
	});
}
