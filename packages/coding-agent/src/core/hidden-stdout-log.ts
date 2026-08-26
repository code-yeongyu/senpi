import * as fs from "node:fs";
import * as path from "node:path";
import { inspect } from "node:util";
import { getDebugLogPath } from "../config.ts";
import { redactSensitiveOutput } from "./sensitive-output.ts";

function appendDebugLogEntry(header: string, text: string): void {
	const debugLogPath = getDebugLogPath();
	const prefix = `[${new Date().toISOString()}] ${header}\n`;
	const redactedText = redactSensitiveOutput(text);
	const suffix = redactedText.endsWith("\n") ? "" : "\n";
	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.appendFileSync(debugLogPath, `${prefix}${redactedText}${suffix}`, { mode: 0o600 });
	fs.chmodSync(debugLogPath, 0o600);
}

export function appendHiddenTuiStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	appendDebugLogEntry("hidden stdout while TUI active", text);
}

/**
 * Record a fatal uncaught crash in the brand debug log.
 *
 * The interactive crash handler restores the real stderr and prints its banner to
 * the terminal, so without this the only record of a crash is terminal scrollback —
 * useless once the terminal is closed, and doubly so when the crash is itself an
 * stderr/terminal failure. Callers must invoke this BEFORE the terminal handoff and
 * must swallow any failure: writing telemetry may never alter the crash path.
 */
export function appendUncaughtCrashLog(origin: string, error: unknown): void {
	appendDebugLogEntry(`uncaught crash (${origin})`, describeCrash(error));
}

function describeCrash(error: unknown): string {
	if (error instanceof Error) {
		// `stack` already starts with "Name: message" in V8, but a caller-supplied or
		// stripped stack may not, so keep the identity line unconditionally.
		const identity = `${error.name}: ${error.message}`;
		const stack = typeof error.stack === "string" && error.stack.length > 0 ? error.stack : undefined;
		return stack === undefined || stack.startsWith(identity) ? (stack ?? identity) : `${identity}\n${stack}`;
	}
	try {
		return typeof error === "string" ? error : inspect(error, { depth: 3 });
	} catch {
		return "<unprintable crash value>";
	}
}
