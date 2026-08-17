export const MAX_RPC_MESSAGE_CHARACTERS = 1_000_000;

interface RpcMessageInput {
	type?: unknown;
	message?: unknown;
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
