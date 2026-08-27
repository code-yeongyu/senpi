import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type CursorExecResolvedCarrier,
	isClassifierRefusal,
	isCursorExecResolved,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentLoopConfig } from "./types.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

type TerminalAssistantMessageEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

export class ProviderRetryWatchdogAbortError extends Error {
	readonly providerCause: string;

	constructor(providerCause: string) {
		super(providerCause);
		this.providerCause = providerCause;
		this.name = "ProviderRetryWatchdogAbortError";
	}
}

export function promoteStopWithPendingToolCalls(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "stop") return message;
	if (!message.content.some((block) => block.type === "toolCall")) return message;
	return { ...message, stopReason: "toolUse" };
}

export function shouldTerminateAssistantTurn(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted" || isClassifierRefusal(message);
}

export function isStreamIdleTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "StreamIdleTimeoutError";
}

/**
 * After tools already finished (Cursor exec-resolved or buffered results),
 * a silent provider is a finished turn, not a failed one.
 */
export function shouldFinalizeIdleAsStop(
	partialMessage: AssistantMessage | null,
	providerToolResults: readonly ToolResultMessage[],
): boolean {
	if (!partialMessage) return false;
	const toolCalls = partialMessage.content.filter((block) => block.type === "toolCall");
	if (toolCalls.length === 0) return false;
	if (providerToolResults.length > 0) return true;
	return toolCalls.every((block) => isCursorExecResolved(block as CursorExecResolvedCarrier));
}

export function createTerminalFailureAssistantMessage(
	model: AgentLoopConfig["model"],
	reason: Extract<AssistantMessage["stopReason"], "aborted" | "error">,
	error: unknown,
	partialMessage: AssistantMessage | null,
): AssistantMessage {
	const errorMessage = error instanceof Error ? error.message : String(error);
	return {
		role: "assistant",
		content: partialMessage?.content ?? [{ type: "text", text: "" }],
		api: partialMessage?.api ?? model.api,
		provider: partialMessage?.provider ?? model.provider,
		model: partialMessage?.model ?? model.id,
		responseModel: partialMessage?.responseModel,
		responseId: partialMessage?.responseId,
		diagnostics: partialMessage?.diagnostics,
		usage: partialMessage?.usage ?? EMPTY_USAGE,
		stopReason: reason,
		errorMessage: errorMessage || (reason === "aborted" ? "Request was aborted" : "Error"),
		...(error instanceof ProviderRetryWatchdogAbortError ? { abortSource: "provider" as const } : {}),
		timestamp: partialMessage?.timestamp ?? Date.now(),
	};
}

export function normalizeTerminalAssistantMessage(
	message: AssistantMessage,
	event: TerminalAssistantMessageEvent,
): AssistantMessage {
	if (event.type === "done") return message;
	const errorMessage = message.errorMessage ?? (event.reason === "aborted" ? "Request was aborted" : "Error");
	if (message.stopReason === event.reason && message.errorMessage === errorMessage) return message;
	return { ...message, stopReason: event.reason, errorMessage };
}
