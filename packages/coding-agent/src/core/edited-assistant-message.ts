import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

export type AssistantEditReason = "empty" | "not-assistant" | "not-found" | "stale-leaf";

/** Wire-level code for an assistant-edit failure; stable across transports. */
export type AssistantEditCode = "empty" | "not_assistant" | "not_found" | "stale_leaf";

const EDIT_CODES: Readonly<Record<AssistantEditReason, AssistantEditCode>> = {
	empty: "empty",
	"not-assistant": "not_assistant",
	"not-found": "not_found",
	"stale-leaf": "stale_leaf",
};

export class AssistantEditError extends Error {
	readonly reason: AssistantEditReason;

	constructor(reason: AssistantEditReason, message: string) {
		super(message);
		this.name = "AssistantEditError";
		this.reason = reason;
	}

	get code(): AssistantEditCode {
		return EDIT_CODES[this.reason];
	}
}

/** Thrown by every tree mutation while a response is streaming; outranks the stale-leaf guard. */
export class SessionStreamingError extends Error {
	readonly code = "streaming" as const;

	constructor() {
		super("Wait for the current response to finish before navigating the session tree.");
		this.name = "SessionStreamingError";
	}
}

/** Optimistic-concurrency guard: the caller's leaf token must equal the session's current leaf. */
export function assertExpectedLeaf(expectedLeafId: string | undefined, currentLeafId: string | null): void {
	if (expectedLeafId === undefined || expectedLeafId === currentLeafId) return;
	throw new AssistantEditError(
		"stale-leaf",
		`Session leaf moved (expected ${expectedLeafId}, now ${currentLeafId ?? "root"})`,
	);
}

export function assistantTextEquals(original: AssistantMessage, text: string): boolean {
	return contentText(original.content, "").trim() === text.trim();
}

/**
 * Text replaces every content block: thinking signatures and tool calls belong to the abandoned
 * response, and a leaf ending in tool calls without results is rejected by providers.
 * Model identity and usage stay so per-path cost and context estimates remain accurate.
 */
export function buildEditedAssistantMessage(original: AssistantMessage, text: string): AssistantMessage {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new AssistantEditError("empty", "Edited assistant response cannot be empty");
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: trimmed }],
		api: original.api,
		provider: original.provider,
		model: original.model,
		...(original.responseModel !== undefined ? { responseModel: original.responseModel } : {}),
		usage: original.usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
