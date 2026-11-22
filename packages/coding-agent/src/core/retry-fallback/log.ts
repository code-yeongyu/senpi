import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rotateLogIfNeeded } from "../log-file-rotation.ts";
import { redactSecrets, redactSensitiveTokenValues } from "../sensitive-output.ts";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_STRING_LENGTH = 200;
const MAX_QUEUED_LINES = 256;
const BLOCKED_KEY =
	/^(?:__proto__|constructor|prototype|headers?|env(?:ironment)?|authorization|credential(?:s)?|password|secret|token|api_?key|client_?secret)$/i;
const ALLOWED_DATA_KEY =
	/^(?:selector|candidate|currentSelector|originalSelector|from|to|model|provider|chainKey|reason|skipReason|classification|thinkingLevel|durationMs|retryAfterMs|error|errorMessage|warning|trigger)$/;
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

export interface SettledFallbackLogger extends FallbackLogger {
	/** Resolves once the one-time removal of earlier log generations has finished and every line logged before it was written. */
	settled(): Promise<void>;
}

const unsettledLoggers = new Set<Promise<void>>();

/** Resolves once every fallback logger created so far has finished its first-start removal and flushed its queue. */
export async function settledFallbackLoggers(): Promise<void> {
	await Promise.all([...unsettledLoggers]);
}

function errorCode(failure: unknown): string {
	if (typeof failure === "object" && failure !== null && "code" in failure && typeof failure.code === "string") {
		return failure.code;
	}
	return "unknown";
}

export function createFallbackLogger(agentDir: string, options: FallbackLoggerOptions = {}): SettledFallbackLogger {
	const filePath = join(agentDir, "logs", "fallback.log");
	const maxBytes = validMaxBytes(options.maxBytes);
	let reportedWriteFailure = false;
	// Lines logged while the earlier generations are still being removed wait here, so the removal can never delete them.
	// They are redacted before they enter the queue and the queue is bounded: the newest lines win, the drops are counted.
	let queued: string[] | undefined = [];
	let dropped = 0;

	function write(line: string): void {
		try {
			writeLine(filePath, line, maxBytes);
		} catch (error) {
			if (!reportedWriteFailure) {
				reportedWriteFailure = true;
				console.error("Unable to write retry fallback debug log", error);
			}
		}
	}

	const settled = retireUnsharedRegistryGenerations(filePath)
		.then(() => undefined)
		.catch((error: unknown) => {
			reportedWriteFailure = true;
			console.error("Unable to remove earlier retry fallback debug log generations", error);
			return error;
		})
		.then((failure: unknown) => {
			const lines = queued ?? [];
			queued = undefined;
			for (const line of lines) write(line);
			if (dropped > 0) {
				write(
					formatLine("warn", "queued_lines_dropped", {
						reason: `${dropped} lines dropped while earlier log generations were removed`,
					}),
				);
			}
			if (failure !== undefined) {
				// The code only: the error text names the agent dir's absolute path.
				write(
					formatLine("warn", "retire_generations_failed", {
						errorMessage: `removal failed: ${errorCode(failure)}`,
					}),
				);
			}
		});
	unsettledLoggers.add(settled);
	void settled.then(() => unsettledLoggers.delete(settled));

	function log(level: "debug" | "info" | "warn", event: string, data?: Record<string, unknown>): void {
		try {
			const line = formatLine(level, event, data);
			if (queued !== undefined) {
				queued.push(redactSensitiveTokenValues(line, "[redacted]"));
				if (queued.length > MAX_QUEUED_LINES) {
					queued.shift();
					dropped += 1;
				}
				return;
			}
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
		settled: () => settled,
	};
}

/**
 * Generations written before every engine copy in a process shared one resolved-value registry (omo#12965) are
 * removed once per agent dir, the first time an engine with the shared registry starts on it; the marker makes every
 * later start leave the logs alone.
 */
async function retireUnsharedRegistryGenerations(filePath: string): Promise<void> {
	const marker = join(dirname(filePath), ".fallback-log-v2");
	if (
		await access(marker).then(
			() => true,
			() => false,
		)
	)
		return;
	await rm(`${filePath}.1`, { force: true });
	await rm(filePath, { force: true });
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(marker, "", { mode: 0o600 });
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
	const text = `${redactSensitiveTokenValues(line, "[redacted]")}\n`;
	rotateLogIfNeeded(filePath, Buffer.byteLength(text), maxBytes);
	const descriptor = openSync(filePath, "a", 0o600);
	try {
		writeSync(descriptor, text);
		fchmodSync(descriptor, 0o600);
	} finally {
		closeSync(descriptor);
	}
}

function serializeValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return safeText(value);
	if (typeof value === "bigint") return safeText(value.toString());
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (typeof value === "undefined") return undefined;
	if (typeof value === "function" || typeof value === "symbol") return safeText(String(value));
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => serializeValue(item, seen) ?? null);
	const result: Record<string, unknown> = {};
	for (const [key, item] of safeEntries(value)) {
		if (!BLOCKED_KEY.test(key)) {
			const safeValue = serializeValue(item, seen);
			if (safeValue !== undefined) result[safeText(key)] = safeValue;
		}
	}
	return result;
}

function safeEntries(value: object): Array<[string, unknown]> {
	try {
		const entries: Array<[string, unknown]> = [];
		for (const key of Object.keys(value)) {
			try {
				const item: unknown = Reflect.get(value, key);
				entries.push([key, item]);
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
	const redacted = redactSecrets(value.replace(SENSITIVE_TEXT, "$1[redacted]"), "[redacted]");
	return redacted.length <= MAX_STRING_LENGTH ? redacted : `${redacted.slice(0, MAX_STRING_LENGTH - 3)}...`;
}
