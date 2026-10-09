import { isBrowserEngine } from "../../core/browser-engine.ts";
import { clientMessageIdentitySchema } from "../../core/client-message-identity.ts";

export const MAX_RPC_MESSAGE_CHARACTERS = 1_000_000;

/**
 * Bounds on `open_session.context`. The host stores the blob per session and republishes
 * it on `list_sessions { include_workers: true }`, so it is bounded at the boundary: an
 * unbounded label map would be per-session memory and per-listing bytes a client controls.
 */
export const SESSION_CONTEXT_LIMITS = {
	keys: 32,
	valueBytes: 16 * 1024,
	totalBytes: 32 * 1024,
} as const;

const SESSION_CONTEXT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

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
		case "model_change_rejected":
			return (
				typeof value.provider === "string" && typeof value.modelId === "string" && typeof value.detail === "string"
			);
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
	if (
		(value.type === "prompt" || value.type === "steer" || value.type === "follow_up") &&
		!clientMessageIdentitySchema.safeParse(value).success
	) {
		return "clientMessageId and clientTurnId must be non-empty strings of at most 256 characters.";
	}
	if (
		(value.type === "steer" || value.type === "follow_up") &&
		value.enqueueOrder !== undefined &&
		!(typeof value.enqueueOrder === "number" && Number.isFinite(value.enqueueOrder))
	) {
		return "enqueueOrder must be a finite number.";
	}
	if (value.type === "append_user_message" && !validContent(value.content)) {
		return "append_user_message content must be a string or text/image content array.";
	}
	if (value.type === "append_session_entry" && !validSessionEntry(value.entry)) {
		return "append_session_entry entry is malformed.";
	}
	return undefined;
}

/**
 * Detail for an `open_session.context` the host refuses, or undefined when the value is
 * absent or a valid context. The caller answers with `invalid_session_context: <detail>`;
 * the detail names the cap that was broken so a client can fix the payload without guessing.
 */
export function sessionContextError(context: unknown): string | undefined {
	if (context === undefined) return undefined;
	if (typeof context !== "object" || context === null || Array.isArray(context)) {
		return "context must be an object of string values.";
	}
	const entries = Object.entries(context as Record<string, unknown>);
	if (entries.length > SESSION_CONTEXT_LIMITS.keys) {
		return `context has ${entries.length} keys, at most ${SESSION_CONTEXT_LIMITS.keys} are accepted.`;
	}
	for (const [key, value] of entries) {
		if (!SESSION_CONTEXT_KEY_PATTERN.test(key)) {
			return `context key "${key}" must match ${SESSION_CONTEXT_KEY_PATTERN.source}.`;
		}
		if (typeof value !== "string") return `context value for key "${key}" must be a string.`;
		const valueBytes = Buffer.byteLength(value);
		if (valueBytes > SESSION_CONTEXT_LIMITS.valueBytes) {
			return `context value for key "${key}" is ${valueBytes} bytes, at most ${SESSION_CONTEXT_LIMITS.valueBytes} bytes are accepted.`;
		}
	}
	const totalBytes = Buffer.byteLength(JSON.stringify(context));
	if (totalBytes > SESSION_CONTEXT_LIMITS.totalBytes) {
		return `context is ${totalBytes} bytes of JSON, at most ${SESSION_CONTEXT_LIMITS.totalBytes} bytes are accepted.`;
	}
	return undefined;
}

/**
 * Detail for an `open_session.kind` the host refuses, or undefined when the value is absent
 * or a known kind. An unknown kind is never treated as `interactive`: a typo would publish
 * machine-driven work to every client that lists sessions.
 */
export function sessionKindError(kind: unknown): string | undefined {
	if (kind === undefined || kind === "interactive" || kind === "worker") return undefined;
	return `kind must be "interactive" or "worker".`;
}

/**
 * Detail for an `open_session.auto_title` the host refuses, or undefined when the
 * value is absent or a boolean. Absent keeps the host-wide default; a non-boolean
 * cannot be coerced without collapsing `true` / `false` / omitted into one state.
 */
export function sessionAutoTitleError(value: unknown): string | undefined {
	if (value === undefined || typeof value === "boolean") return undefined;
	return "auto_title must be a boolean.";
}

/**
 * Detail for an `open_session.promptSurface` the host refuses, or undefined when the value is
 * absent or a known surface. An unknown value is never read as `terminal`: a client that asked
 * for the app or chat prompt must not silently get the routing line.
 */
export function sessionPromptSurfaceError(value: unknown): string | undefined {
	if (value === undefined || value === "terminal" || value === "app" || value === "chat") return undefined;
	return `promptSurface must be "terminal", "app" or "chat".`;
}

/**
 * Detail for an `open_session.browserEngine` the host refuses, or undefined when the value is absent
 * or a known engine. An unknown value is never read as `none`: a client that asked for the user's
 * own browser must not silently run without one.
 */
export function sessionBrowserEngineError(value: unknown): string | undefined {
	if (value === undefined || isBrowserEngine(value)) return undefined;
	return `browserEngine must be "connected", "builtin" or "none".`;
}

const MAX_RETRY_FALLBACK_CHAINS = 32;
const MAX_RETRY_FALLBACK_ENTRIES = 32;
const MAX_RETRY_FALLBACK_SELECTOR_LENGTH = 512;

/**
 * Detail for an `open_session.retryFallback` the host refuses, or undefined when it is absent or well
 * formed: `{ modelFallback: boolean, fallbackChains: Record<string, string[]> }`, at most 32 chains of at
 * most 32 non-empty selectors. A malformed profile is refused rather than ignored, so a caller that asked
 * for a chain never runs without one unknowingly.
 */
export function sessionRetryFallbackError(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const shape = "retryFallback must be { modelFallback: boolean, fallbackChains: Record<string, string[]> }.";
	if (typeof value !== "object" || value === null || Array.isArray(value)) return shape;
	const record = value as Record<string, unknown>;
	if (typeof record.modelFallback !== "boolean") return shape;
	const chains = record.fallbackChains;
	if (typeof chains !== "object" || chains === null || Array.isArray(chains)) return shape;
	const entries = Object.entries(chains as Record<string, unknown>);
	if (entries.length > MAX_RETRY_FALLBACK_CHAINS)
		return `retryFallback allows at most ${MAX_RETRY_FALLBACK_CHAINS} chains.`;
	for (const [key, selectors] of entries) {
		if (!isSelector(key)) return shape;
		if (!Array.isArray(selectors) || !selectors.every(isSelector)) return shape;
		if (selectors.length > MAX_RETRY_FALLBACK_ENTRIES)
			return `retryFallback allows at most ${MAX_RETRY_FALLBACK_ENTRIES} entries per chain.`;
	}
	return undefined;
}

function isSelector(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_RETRY_FALLBACK_SELECTOR_LENGTH;
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
