import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_STRING_LENGTH = 200;
const BLOCKED_KEY =
	/^(?:__proto__|constructor|prototype|headers?|env(?:ironment)?|authorization|credential(?:s)?|password|secret|token|api_?key|client_?secret)$/i;
const ALLOWED_DATA_KEY =
	/^(?:selector|candidate|currentSelector|originalSelector|from|to|model|chainKey|reason|skipReason|classification|thinkingLevel|durationMs|retryAfterMs|error|errorMessage|warning)$/;
const SENSITIVE_TEXT =
	/((?:authorization\s*[:=]\s*(?:bearer|basic)\s+)|(?:bearer\s+)|(?:[?&](?:api[_-]?key|token|secret|password|auth(?:orization)?)=))[^\s&,"'}\]]+/gi;

export interface FallbackLogger {
	debug(event: string, data?: Record<string, unknown>): void;
	info(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
}

export interface FallbackLoggerOptions {
	maxBytes?: number;
}

export function createFallbackLogger(agentDir: string, options: FallbackLoggerOptions = {}): FallbackLogger {
	const filePath = join(agentDir, "logs", "fallback.log");
	const maxBytes = validMaxBytes(options.maxBytes);
	let reportedWriteFailure = false;

	function log(level: "debug" | "info" | "warn", event: string, data?: Record<string, unknown>): void {
		try {
			const line = formatLine(level, event, data);
			writeLine(filePath, line, maxBytes);
		} catch (error) {
			if (!reportedWriteFailure) {
				reportedWriteFailure = true;
				console.error("Unable to write retry fallback debug log", error);
			}
		}
	}

	return {
		debug: (event, data) => log("debug", event, data),
		info: (event, data) => log("info", event, data),
		warn: (event, data) => log("warn", event, data),
	};
}

function validMaxBytes(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_BYTES;
}

function formatLine(
	level: "debug" | "info" | "warn",
	event: string,
	data: Record<string, unknown> | undefined,
): string {
	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		event: safeText(event),
	};
	if (data !== undefined) {
		for (const [key, value] of safeEntries(data)) {
			if (ALLOWED_DATA_KEY.test(key) && !BLOCKED_KEY.test(key)) {
				const safeValue = serializeValue(value, new WeakSet<object>());
				if (safeValue !== undefined) entry[key] = safeValue;
			}
		}
	}
	return JSON.stringify(entry);
}

function writeLine(filePath: string, line: string, maxBytes: number): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const text = `${line}\n`;
	if (fileExceedsCap(filePath, Buffer.byteLength(text), maxBytes)) {
		rmSync(`${filePath}.1`, { force: true });
		renameSync(filePath, `${filePath}.1`);
		chmodSync(`${filePath}.1`, 0o600);
	}
	const descriptor = openSync(filePath, "a", 0o600);
	try {
		writeSync(descriptor, text);
	} finally {
		closeSync(descriptor);
	}
	chmodSync(filePath, 0o600);
}

function fileExceedsCap(filePath: string, incomingBytes: number, maxBytes: number): boolean {
	try {
		return statSync(filePath).size + incomingBytes > maxBytes;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function serializeValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return safeText(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (typeof value === "undefined") return undefined;
	if (typeof value === "function" || typeof value === "symbol") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => serializeValue(item, seen) ?? null);
	const result: Record<string, unknown> = {};
	for (const [key, item] of safeEntries(value)) {
		if (!BLOCKED_KEY.test(key)) {
			const safeValue = serializeValue(item, seen);
			if (safeValue !== undefined) result[key] = safeValue;
		}
	}
	return result;
}

function safeEntries(value: object): Array<[string, unknown]> {
	try {
		const entries: Array<[string, unknown]> = [];
		for (const key of Object.keys(value)) {
			try {
				entries.push([key, value[key as keyof typeof value]]);
			} catch {
				entries.push([key, "[Unreadable]"]);
			}
		}
		return entries;
	} catch {
		return [["unserializable", "[Unreadable]"]];
	}
}

function safeText(value: string): string {
	const redacted = value.replace(SENSITIVE_TEXT, "$1[redacted]");
	return redacted.length <= MAX_STRING_LENGTH ? redacted : `${redacted.slice(0, MAX_STRING_LENGTH - 3)}...`;
}
