import { appendFileSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envValue } from "../../../brand.ts";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_KEYS = new Set([
	"origin",
	"reason",
	"route",
	"variant",
	"generation",
	"requestId",
	"sessionId",
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
	"idle_applied",
	"blocking_started",
	"warm_consumed",
	"core_route_generated",
	"skip_cap",
	"skip_breaker",
	"skip_cursor_mid_turn",
	"threshold_trigger",
	"hard_limit_trigger",
	"grace_deferred",
	"breaker_deterministic_fallback",
	"emergency_prune",
	"ineffective_counted",
	"summary_failed",
	"remote_aborted",
	"blocking_aborted",
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
	| "skip_cursor_mid_turn"
	| "threshold_trigger"
	| "hard_limit_trigger"
	| "grace_deferred"
	| "breaker_deterministic_fallback"
	| "emergency_prune"
	| "ineffective_counted"
	| "idle_trigger"
	| "idle_applied"
	| "summary_failed"
	| "remote_aborted"
	| "blocking_aborted";

export interface CompactionLoggerData {
	origin?: string;
	reason?: string;
	route?: string;
	variant?: string;
	generation?: number;
	requestId?: string;
	sessionId?: string;
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
	getSessionId?: () => string;
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
			const line = formatLine(level, event, { ...data, sessionId: options.getSessionId?.() ?? data?.sessionId });
			writeLine(filePath, line, maxBytes, options.sink);
			if (options.mirrorToStderr ?? envValue("COMPACTION_DEBUG") === "1") {
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

/**
 * Lines waiting to be appended, per log file. Writing synchronously stalled the UI thread on a busy
 * disk (one 486 ms write was measured while a background event stream ran), so lines are appended
 * in order by one asynchronous writer per file; whatever is still queued at exit is written then.
 */
const pendingLines = new Map<string, { text: string; unconfirmed: string; readonly maxBytes: number }>();

function writeLine(filePath: string, line: string, maxBytes: number, sink?: (line: string) => void): void {
	const text = `${line}\n`;
	if (sink) sink(line);
	const pending = pendingLines.get(filePath);
	if (pending) {
		pending.text += text;
		return;
	}
	pendingLines.set(filePath, { text, unconfirmed: "", maxBytes });
	if (!exitFlushRegistered) {
		exitFlushRegistered = true;
		process.once("exit", flushPendingLinesSync);
	}
	const drain = drainLines(filePath);
	activeDrains.add(drain);
	void drain.finally(() => activeDrains.delete(drain));
}

const activeDrains = new Set<Promise<void>>();

/** Resolves once every line logged so far was appended, or its write failed (logging is best-effort). */
export async function flushCompactionLogs(): Promise<void> {
	while (activeDrains.size > 0) await Promise.all([...activeDrains]);
}

let exitFlushRegistered = false;
let reportedWriteFailure = false;

/**
 * Appends queued lines in order. Rotation is decided per line, as when each line was written on its
 * own: a line that would push the file past `maxBytes` starts a new file. `unconfirmed` holds what is
 * not yet known to be appended, so an exit during a write still writes it (that chunk may then appear
 * twice, which beats losing it).
 */
async function drainLines(filePath: string): Promise<void> {
	const pending = pendingLines.get(filePath);
	try {
		if (!pending) return;
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
		let size = await fileSize(filePath);
		while (pending.text.length > 0) {
			pending.unconfirmed = pending.text;
			pending.text = "";
			let chunk = "";
			let chunkBytes = 0;
			for (const line of pending.unconfirmed.split(/(?<=\n)/)) {
				const lineBytes = Buffer.byteLength(line);
				if (size + chunkBytes + lineBytes > pending.maxBytes && size + chunkBytes > 0) {
					if (chunk) await appendFile(filePath, chunk, { mode: 0o600 });
					pending.unconfirmed = pending.unconfirmed.slice(chunk.length);
					await rename(filePath, `${filePath}.1`).catch(() => undefined);
					size = 0;
					chunk = "";
					chunkBytes = 0;
				}
				chunk += line;
				chunkBytes += lineBytes;
			}
			if (chunk) await appendFile(filePath, chunk, { mode: 0o600 });
			size += chunkBytes;
			pending.unconfirmed = "";
		}
	} catch (error) {
		if (!reportedWriteFailure) {
			reportedWriteFailure = true;
			console.error("Unable to write compaction log", error);
		}
	} finally {
		pendingLines.delete(filePath);
	}
}

function flushPendingLinesSync(): void {
	for (const [filePath, pending] of pendingLines) {
		const text = pending.unconfirmed + pending.text;
		if (text.length === 0) continue;
		try {
			appendFileSync(filePath, text, { mode: 0o600 });
		} catch {}
	}
	pendingLines.clear();
}

async function fileSize(filePath: string): Promise<number> {
	try {
		return (await stat(filePath)).size;
	} catch {
		return 0;
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
