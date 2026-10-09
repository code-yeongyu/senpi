import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

export type UserEditReason = "empty" | "not-user" | "not-found" | "stale-leaf";

/** Wire-level code for a user-edit failure; stable across transports. */
export type UserEditCode = "empty" | "not_user" | "not_found" | "stale_leaf";

const EDIT_CODES: Readonly<Record<UserEditReason, UserEditCode>> = {
	empty: "empty",
	"not-user": "not_user",
	"not-found": "not_found",
	"stale-leaf": "stale_leaf",
};

export class UserEditError extends Error {
	readonly reason: UserEditReason;

	constructor(reason: UserEditReason, message: string) {
		super(message);
		this.name = "UserEditError";
		this.reason = reason;
	}

	get code(): UserEditCode {
		return EDIT_CODES[this.reason];
	}
}

/**
 * Optimistic-concurrency guard for the user-edit surface: the caller's leaf token must equal the
 * session's current leaf. Mirrors `assertExpectedLeaf` so a user edit reports its own error type.
 */
export function assertExpectedUserLeaf(expectedLeafId: string | undefined, currentLeafId: string | null): void {
	if (expectedLeafId === undefined || expectedLeafId === currentLeafId) return;
	throw new UserEditError(
		"stale-leaf",
		`Session leaf moved (expected ${expectedLeafId}, now ${currentLeafId ?? "root"})`,
	);
}

export function userTextEquals(original: UserMessage, text: string): boolean {
	return contentText(original.content, "").trim() === text.trim();
}

/**
 * Text replaces every text block; every other block is carried over untouched. Unlike an edited
 * assistant response - whose thinking and tool calls belong to the abandoned branch - a prompt's
 * attachments are the user's own input, so dropping them would destroy data the model still needs.
 */
export function buildEditedUserMessage(original: UserMessage, text: string): UserMessage {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new UserEditError("empty", "Edited user message cannot be empty");
	}
	const attachments: ImageContent[] = Array.isArray(original.content)
		? original.content.filter((block): block is ImageContent => block.type !== "text")
		: [];
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: trimmed }, ...attachments];
	return {
		role: "user",
		content,
		timestamp: Date.now(),
	};
}
