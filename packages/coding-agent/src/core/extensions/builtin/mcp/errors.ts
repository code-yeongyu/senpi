export type McpErrorKind = "connect" | "protocol" | "tool_exec" | "auth" | "timeout";

export interface McpErrorOptions {
	readonly cause?: unknown;
	readonly phase?: string;
	readonly retriable?: boolean;
	readonly serverName?: string;
}

export abstract class McpError extends Error {
	readonly kind: McpErrorKind;
	readonly phase?: string;
	readonly retriable?: boolean;
	readonly serverName?: string;

	protected constructor(kind: McpErrorKind, name: string, message: string, options: McpErrorOptions = {}) {
		super(message);
		this.name = name;
		this.kind = kind;
		this.phase = options.phase;
		this.retriable = options.retriable;
		this.serverName = options.serverName;
		if (options.cause !== undefined) {
			Object.defineProperty(this, "cause", {
				configurable: true,
				value: options.cause,
				writable: false,
			});
		}
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class ConnectError extends McpError {
	constructor(message: string, options: McpErrorOptions = {}) {
		super("connect", "ConnectError", message, options);
	}
}

export class ProtocolError extends McpError {
	constructor(message: string, options: McpErrorOptions = {}) {
		super("protocol", "ProtocolError", message, options);
	}
}

export class ToolExecError extends McpError {
	constructor(message: string, options: McpErrorOptions = {}) {
		super("tool_exec", "ToolExecError", message, options);
	}
}

export class AuthError extends McpError {
	constructor(message: string, options: McpErrorOptions = {}) {
		super("auth", "AuthError", message, options);
	}
}

export class TimeoutError extends McpError {
	constructor(message: string, options: McpErrorOptions = {}) {
		super("timeout", "TimeoutError", message, options);
	}
}

const RETRIABLE_STATUS_CODES = new Set([404, 502, 503]);
const RETRIABLE_NUMERIC_CODES = new Set([-32001]);
const RETRIABLE_TEXT = ["econnrefused", "connection refused", "transport closed"];

export function isRetriableMcpError(error: unknown): boolean {
	if (error instanceof McpError && error.retriable === true) return true;

	const seen = new Set<unknown>();
	if (hasRetriableNumericSignal(error, seen)) return true;

	const text = collectText(error, new Set()).join(" ").toLowerCase();
	if (RETRIABLE_TEXT.some((needle) => text.includes(needle))) return true;
	return /\b(?:404|502|503)\b/.test(text);
}

function hasRetriableNumericSignal(value: unknown, seen: Set<unknown>): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (seen.has(value)) return false;
	seen.add(value);

	const code = numberFromUnknown(getProperty(value, "code"));
	if (code !== undefined && RETRIABLE_NUMERIC_CODES.has(code)) return true;

	const status = numberFromUnknown(getProperty(value, "status"));
	if (status !== undefined && RETRIABLE_STATUS_CODES.has(status)) return true;

	const statusCode = numberFromUnknown(getProperty(value, "statusCode"));
	if (statusCode !== undefined && RETRIABLE_STATUS_CODES.has(statusCode)) return true;

	return (
		hasRetriableNumericSignal(getProperty(value, "response"), seen) ||
		hasRetriableNumericSignal(getProperty(value, "cause"), seen)
	);
}

function collectText(value: unknown, seen: Set<unknown>): string[] {
	if (typeof value === "string") return [value];
	if (typeof value === "number") return [String(value)];
	if (typeof value !== "object" || value === null) return [];
	if (seen.has(value)) return [];
	seen.add(value);

	const parts: string[] = [];
	if (value instanceof Error) {
		parts.push(value.message, value.name);
	}

	for (const key of ["message", "code", "status", "statusCode"] as const) {
		const property = getProperty(value, key);
		if (typeof property === "string" || typeof property === "number") {
			parts.push(String(property));
		}
	}

	parts.push(...collectText(getProperty(value, "response"), seen));
	parts.push(...collectText(getProperty(value, "cause"), seen));
	return parts;
}

function numberFromUnknown(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function getProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}
