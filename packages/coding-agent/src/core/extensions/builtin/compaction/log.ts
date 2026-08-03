import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_KEYS = new Set([
	"origin",
	"reason",
	"route",
	"variant",
	"generation",
	"requestId",
	"tokens",
	"tokensBefore",
	"savedTokens",
	"savingsRatio",
	"contextWindow",
	"threshold",
	"remainingSec",
	"count",
	"durationMs",
]);
const DEBUG_PREFIX = "[senpi-compaction]";
const EVENTS = new Set([
	"speculative_started",
	"speculative_applied",
	"speculative_stale",
	"speculative_invalidated",
	"idle_trigger",
	"blocking_started",
	"warm_consumed",
	"core_route_generated",
	"skip_cap",
	"skip_breaker",
	"threshold_trigger",
	"hard_limit_trigger",
	"emergency_prune",
	"ineffective_counted",
	"summary_failed",
]);

export type CompactionLoggerEvent =
	| "speculative_started"
	| "speculative_applied"
	| "speculative_stale"
	| "speculative_invalidated"
	| "blocking_started"
	| "warm_consumed"
	| "core_route_generated"
	| "skip_cap"
	| "skip_breaker"
	| "threshold_trigger"
	| "hard_limit_trigger"
	| "emergency_prune"
	| "ineffective_counted"
	| "idle_trigger"
	| "summary_failed";

export interface CompactionLoggerData {
	origin?: string;
	reason?: string;
	route?: string;
	variant?: string;
	generation?: number;
	requestId?: string;
	tokens?: number;
	tokensBefore?: number;
	savedTokens?: number;
	savingsRatio?: number;
	contextWindow?: number;
	threshold?: number;
	remainingSec?: number;
	count?: number;
	durationMs?: number;
}

export interface CompactionLogger {
	debug(event: CompactionLoggerEvent, data?: CompactionLoggerData): void;
	info(event: CompactionLoggerEvent, data?: CompactionLoggerData): void;
}

export interface CompactionLoggerOptions {
	sink?: (line: string) => void;
	mirrorToStderr?: boolean;
	maxBytes?: number;
}

export function createCompactionLogger(
	agentDir: string | undefined,
	options: CompactionLoggerOptions = {},
): CompactionLogger {
	if (typeof agentDir !== "string" || agentDir.length === 0) {
		return { debug: () => {}, info: () => {} };
	}
	const filePath = join(agentDir, "logs", "compaction.log");
	const maxBytes = validMaxBytes(options.maxBytes);
	let reportedFailure = false;

	function log(level: "debug" | "info", event: CompactionLoggerEvent, data?: CompactionLoggerData): void {
		try {
			if (!EVENTS.has(event)) return;
			const line = formatLine(level, event, data);
			writeLine(filePath, line, maxBytes, options.sink);
			if (options.mirrorToStderr ?? process.env.SENPI_COMPACTION_DEBUG === "1") {
				console.error(DEBUG_PREFIX, line);
			}
		} catch (error) {
			if (!reportedFailure) {
				reportedFailure = true;
				console.error("Unable to write compaction log", error);
			}
		}
	}

	return {
		debug: (event, data) => log("debug", event, data),
		info: (event, data) => log("info", event, data),
	};
}

function validMaxBytes(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_BYTES;
}

function formatLine(level: "debug" | "info", event: CompactionLoggerEvent, data?: CompactionLoggerData): string {
	const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
	if (data) {
		for (const [key, value] of Object.entries(data)) {
			if (!ALLOWED_KEYS.has(key)) continue;
			const safeValue = safeValueOf(value, new WeakSet<object>());
			if (safeValue !== undefined) entry[key] = safeValue;
		}
	}
	return JSON.stringify(entry);
}

function writeLine(filePath: string, line: string, maxBytes: number, sink?: (line: string) => void): void {
	const text = `${line}\n`;
	if (sink) sink(line);
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	if (needsRotate(filePath, Buffer.byteLength(text), maxBytes)) {
		const rotated = `${filePath}.1`;
		renameSync(filePath, rotated);
	}
	const fd = openSync(filePath, "a", 0o600);
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

function needsRotate(filePath: string, incomingBytes: number, maxBytes: number): boolean {
	try {
		return statSync(filePath).size + incomingBytes > maxBytes;
	} catch {
		return false;
	}
}

function safeValueOf(value: unknown, seen: WeakSet<object>): unknown {
	if (value === undefined) return undefined;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
		return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "symbol" || typeof value === "function") return String(value);
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => safeValueOf(item, seen));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (ALLOWED_KEYS.has(key)) {
			const safe = safeValueOf(item, seen);
			if (safe !== undefined) out[key] = safe;
		}
	}
	return out;
}
