export const MAX_RPC_MESSAGE_CHARACTERS = 1_000_000;

interface RpcMessageInput {
	type?: unknown;
	message?: unknown;
}

function validContent(content: unknown): boolean {
	if (typeof content === "string") return true;
	return (
		Array.isArray(content) &&
		content.every((item) => {
			if (typeof item !== "object" || item === null) return false;
			const value = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
			return value.type === "text"
				? typeof value.text === "string"
				: value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
		})
	);
}

function validBaseEntry(entry: Record<string, unknown>): boolean {
	return (
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string") &&
		typeof entry.timestamp === "string"
	);
}

function validSessionEntry(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
	const value = entry as Record<string, unknown>;
	if (!validBaseEntry(value)) return false;
	switch (value.type) {
		case "message": {
			const message = value.message;
			if (typeof message !== "object" || message === null) return false;
			const item = message as { role?: unknown; content?: unknown };
			return ["user", "assistant", "tool"].includes(item.role as string) && validContent(item.content);
		}
		case "thinking_level_change":
			return typeof value.thinkingLevel === "string";
		case "model_change":
			return typeof value.provider === "string" && typeof value.modelId === "string";
		case "compaction":
			return (
				typeof value.summary === "string" &&
				typeof value.firstKeptEntryId === "string" &&
				typeof value.tokensBefore === "number"
			);
		case "branch_summary":
			return typeof value.fromId === "string" && typeof value.summary === "string";
		case "custom":
			return typeof value.customType === "string";
		case "custom_message":
			return (
				typeof value.customType === "string" && validContent(value.content) && typeof value.display === "boolean"
			);
		case "label":
			return typeof value.targetId === "string" && (value.label === undefined || typeof value.label === "string");
		case "session_info":
			return value.name === undefined || typeof value.name === "string";
		default:
			return false;
	}
}

export function rpcCommandPayloadError(command: unknown): string | undefined {
	if (rpcCommandShapeError(command)) return undefined;
	const value = command as Record<string, unknown>;
	if (value.type === "append_user_message" && !validContent(value.content)) {
		return "append_user_message content must be a string or text/image content array.";
	}
	if (value.type === "append_session_entry" && !validSessionEntry(value.entry)) {
		return "append_session_entry entry is malformed.";
	}
	return undefined;
}

export function rpcCommandShapeError(command: unknown): string | undefined {
	if (typeof command !== "object" || command === null || Array.isArray(command)) {
		return "RPC command must be a JSON object.";
	}
	return undefined;
}

export function rpcMessageLengthError(command: unknown): string | undefined {
	if (rpcCommandShapeError(command)) return undefined;
	const input = command as RpcMessageInput;
	if (input.type !== "prompt" && input.type !== "steer" && input.type !== "follow_up") {
		return undefined;
	}
	if (typeof input.message !== "string" || input.message.length <= MAX_RPC_MESSAGE_CHARACTERS) {
		return undefined;
	}
	return `RPC ${input.type} message exceeds ${MAX_RPC_MESSAGE_CHARACTERS} characters.`;
}
