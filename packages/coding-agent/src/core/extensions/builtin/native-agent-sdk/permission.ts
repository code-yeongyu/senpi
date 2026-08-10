import type { ToolKind } from "@agentclientprotocol/sdk";

export type NativeAgentPermissionRequest = {
	readonly provider: string;
	readonly kind?: ToolKind;
	readonly title: string;
	readonly rawInput?: unknown;
};

export type NativeAgentPermissionTarget = {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
};

type NativeAgentPermissionHandler = (request: NativeAgentPermissionRequest) => Promise<boolean>;

const handlers = new Map<string, NativeAgentPermissionHandler>();

function inputRecord(rawInput: unknown): Record<string, unknown> {
	if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return {};
	return Object.fromEntries(Object.entries(rawInput));
}

function withFallback(rawInput: unknown, key: string, fallback: string): Record<string, unknown> {
	const input = inputRecord(rawInput);
	if (input[key] !== undefined) return input;
	return {
		...input,
		[key]: typeof rawInput === "string" ? rawInput : fallback,
	};
}

export function nativeAgentPermissionTarget(request: NativeAgentPermissionRequest): NativeAgentPermissionTarget {
	switch (request.kind) {
		case "execute":
			return { toolName: "bash", input: withFallback(request.rawInput, "command", request.title) };
		case "read":
			return { toolName: "read", input: withFallback(request.rawInput, "path", request.title) };
		case "edit":
		case "delete":
		case "move":
			return { toolName: "edit", input: withFallback(request.rawInput, "path", request.title) };
		case "search":
			return { toolName: "grep", input: withFallback(request.rawInput, "pattern", request.title) };
		case "fetch":
			return { toolName: "websearch", input: withFallback(request.rawInput, "query", request.title) };
		case "think":
		case "switch_mode":
		case "other":
			return {
				toolName: `native_agent_${request.kind}`,
				input: inputRecord(request.rawInput),
			};
		case undefined:
			return { toolName: "native_agent_other", input: inputRecord(request.rawInput) };
		default:
			return assertNever(request.kind);
	}
}

export function registerNativeAgentPermissionHandler(
	sessionId: string,
	handler: NativeAgentPermissionHandler,
): () => void {
	handlers.set(sessionId, handler);
	return () => {
		if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
	};
}

export async function requestNativeAgentPermission(
	sessionId: string | undefined,
	request: NativeAgentPermissionRequest,
): Promise<boolean> {
	if (sessionId === undefined) return false;
	const handler = handlers.get(sessionId);
	return handler ? handler(request) : false;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported native agent permission kind: ${String(value)}`);
}
