import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200;
const SENSITIVE_PATH = /(^|[/\\])(?:auth\.json|credentials?(?:\.[^/\\]+)?)$/i;
const SENSITIVE_TEXT =
	/((?:authorization\s*[:=]\s*(?:bearer|basic)\s+)|(?:bearer\s+)|(?:[?&](?:api[_-]?key|token|secret|password|auth(?:orization)?)=))[^\s&,"'}\]]+/gi;

export type ConfigReloadLogLevel = "debug" | "info" | "warn" | "error";

export type ConfigReloadLogEvent =
	| "watcher_started"
	| "change_detected"
	| "self_write_suppressed"
	| "reload_requested"
	| "reload_completed"
	| "validation_rejected"
	| "registration_rejected"
	| "registration_rejection_suppressed"
	| "watcher_error"
	| "registration_added"
	| "registration_removed";

export interface ConfigReloadLogDetails {
	watcher_started: { targetCount: number };
	change_detected: { registrationId: string; paths: readonly string[]; deferred: boolean };
	self_write_suppressed: { path: string };
	reload_requested: { reason: string; paths: readonly string[] };
	reload_completed: { durationMs: number };
	validation_rejected: { registrationId: string; errorCount: number };
	registration_rejected: { registrationId: string; errorCount: number };
	registration_rejection_suppressed: { registrationId: string };
	watcher_error: { path: string; message: string };
	registration_added: { id: string };
	registration_removed: { id: string };
}

export interface ConfigReloadLogStatus {
	written: boolean;
	disabled: boolean;
}

export interface ConfigReloadLogger {
	debug<Event extends ConfigReloadLogEvent>(
		event: Event,
		details: ConfigReloadLogDetails[Event],
	): ConfigReloadLogStatus;
	info<Event extends ConfigReloadLogEvent>(
		event: Event,
		details: ConfigReloadLogDetails[Event],
	): ConfigReloadLogStatus;
	warn<Event extends ConfigReloadLogEvent>(
		event: Event,
		details: ConfigReloadLogDetails[Event],
	): ConfigReloadLogStatus;
	error<Event extends ConfigReloadLogEvent>(
		event: Event,
		details: ConfigReloadLogDetails[Event],
	): ConfigReloadLogStatus;
}

export interface ConfigReloadLoggerOptions {
	maxBytes?: number;
}

export function createConfigReloadLogger(
	agentDir: string,
	options: ConfigReloadLoggerOptions = {},
): ConfigReloadLogger {
	const filePath = join(agentDir, "logs", "config-reload.log");
	const maxBytes = validMaxBytes(options.maxBytes);
	let disabled = false;

	function log<Event extends ConfigReloadLogEvent>(
		level: ConfigReloadLogLevel,
		event: Event,
		details: ConfigReloadLogDetails[Event],
	): ConfigReloadLogStatus {
		if (disabled) return { written: false, disabled: true };
		try {
			writeLine(filePath, JSON.stringify(formatEntry(level, event, details)), maxBytes);
			return { written: true, disabled: false };
		} catch {
			disabled = true;
			return { written: false, disabled: true };
		}
	}

	return {
		debug: (event, details) => log("debug", event, details),
		info: (event, details) => log("info", event, details),
		warn: (event, details) => log("warn", event, details),
		error: (event, details) => log("error", event, details),
	};
}

function validMaxBytes(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_BYTES;
}

function formatEntry<Event extends ConfigReloadLogEvent>(
	level: ConfigReloadLogLevel,
	event: Event,
	details: ConfigReloadLogDetails[Event],
): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		event,
	};

	switch (event) {
		case "watcher_started": {
			const eventDetails = details as ConfigReloadLogDetails["watcher_started"];
			entry.targetCount = finiteNumber(eventDetails.targetCount);
			break;
		}
		case "change_detected": {
			const eventDetails = details as ConfigReloadLogDetails["change_detected"];
			entry.registrationId = safeText(eventDetails.registrationId);
			entry.paths = safePaths(eventDetails.paths);
			entry.deferred = eventDetails.deferred === true;
			break;
		}
		case "self_write_suppressed":
			addSafePath(entry, (details as ConfigReloadLogDetails["self_write_suppressed"]).path);
			break;
		case "reload_requested": {
			const eventDetails = details as ConfigReloadLogDetails["reload_requested"];
			entry.reason = safeText(eventDetails.reason);
			entry.paths = safePaths(eventDetails.paths);
			break;
		}
		case "reload_completed":
			entry.durationMs = finiteNumber((details as ConfigReloadLogDetails["reload_completed"]).durationMs);
			break;
		case "validation_rejected":
		case "registration_rejected": {
			const eventDetails = details as ConfigReloadLogDetails["validation_rejected"];
			entry.registrationId = safeText(eventDetails.registrationId);
			entry.errorCount = finiteNumber(eventDetails.errorCount);
			break;
		}
		case "watcher_error": {
			const eventDetails = details as ConfigReloadLogDetails["watcher_error"];
			addSafePath(entry, eventDetails.path);
			entry.message = safeText(eventDetails.message);
			break;
		}
		case "registration_added":
		case "registration_removed":
			entry.id = safeText((details as ConfigReloadLogDetails["registration_added"]).id);
			break;
	}

	return entry;
}

function finiteNumber(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function addSafePath(entry: Record<string, unknown>, path: string): void {
	if (!SENSITIVE_PATH.test(path)) entry.path = safeText(path);
}

function safePaths(paths: readonly string[]): string[] {
	return paths.filter((path) => !SENSITIVE_PATH.test(path)).map(safeText);
}

function safeText(value: string): string {
	const redacted = value.replace(SENSITIVE_TEXT, "$1[redacted]");
	return redacted.length <= MAX_TEXT_LENGTH ? redacted : `${redacted.slice(0, MAX_TEXT_LENGTH - 3)}...`;
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
