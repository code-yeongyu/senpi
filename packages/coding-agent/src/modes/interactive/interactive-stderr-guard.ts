import * as fs from "node:fs";
import * as path from "node:path";
import { format } from "node:util";
import { getDebugLogPath } from "../../config.ts";
import { restoreStderr, takeOverStderr } from "../../core/output-guard.ts";
import { redactSensitiveOutput } from "../../core/sensitive-output.ts";
import {
	loadStderrFdSyscalls,
	redirectStderrFd,
	type StderrFdRedirect,
	type StderrFdSyscalls,
} from "./stderr-fd-redirect.ts";
import { redirectStdoutFd, type StdoutFdRedirect } from "./stdout-fd-redirect.ts";

const consoleLevels = ["error", "info", "warn"] as const;

type ConsoleLevel = (typeof consoleLevels)[number];
type ConsoleMethod = (...data: unknown[]) => void;

interface InteractiveConsoleState {
	readonly error: ConsoleMethod;
	readonly info: ConsoleMethod;
	readonly warn: ConsoleMethod;
}

let interactiveConsoleState: InteractiveConsoleState | undefined;
let stderrFdSyscalls: StderrFdSyscalls | undefined;
let stderrFdRedirect: StderrFdRedirect | undefined;
let stdoutFdRedirect: StdoutFdRedirect | undefined;
let hiddenOutputCapTimer: ReturnType<typeof setInterval> | undefined;

/** Hidden fd 1/fd 2 output above this size is dropped, so a child printing forever cannot fill the disk (#2815). */
export const HIDDEN_OUTPUT_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** The most recent hidden output kept when the cap is hit. */
const HIDDEN_OUTPUT_LOG_KEPT_TAIL_BYTES = 256 * 1024;
const HIDDEN_OUTPUT_CAP_CHECK_MS = 5_000;

/**
 * Keeps the debug log under `maxBytes` while fd 1 and fd 2 are redirected into it: past the cap the
 * file is cut back to its most recent tail behind one marker line. The redirected descriptors are
 * opened for append, so writers keep appending at the new end. Returns whether it cut.
 */
export function capHiddenOutputLog(logPath: string, maxBytes = HIDDEN_OUTPUT_LOG_MAX_BYTES): boolean {
	let size: number;
	try {
		size = fs.statSync(logPath).size;
	} catch {
		return false;
	}
	if (size <= maxBytes) return false;
	const keep = Math.min(HIDDEN_OUTPUT_LOG_KEPT_TAIL_BYTES, maxBytes);
	const tail = Buffer.alloc(keep);
	const fd = fs.openSync(logPath, "r");
	let read: number;
	try {
		read = fs.readSync(fd, tail, 0, keep, size - keep);
	} finally {
		fs.closeSync(fd);
	}
	fs.truncateSync(logPath, 0);
	fs.appendFileSync(
		logPath,
		`[${new Date().toISOString()}] debug log cut at ${size} bytes (cap ${maxBytes}); the last ${keep} bytes follow\n`,
	);
	fs.appendFileSync(logPath, tail.subarray(0, read));
	return true;
}

function appendHiddenInteractiveStderr(text: string): void {
	if (text.length === 0) {
		return;
	}
	const debugLogPath = getDebugLogPath();
	const prefix = `[${new Date().toISOString()}] hidden stderr while TUI active\n`;
	const redactedText = redactSensitiveOutput(text);
	const suffix = redactedText.endsWith("\n") ? "" : "\n";
	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.appendFileSync(debugLogPath, `${prefix}${redactedText}${suffix}`, { mode: 0o600 });
	fs.chmodSync(debugLogPath, 0o600);
}

function replaceConsoleMethod(level: ConsoleLevel, method: ConsoleMethod): void {
	Object.defineProperty(console, level, {
		configurable: true,
		value: method,
		writable: true,
	});
}

function takeOverInteractiveConsole(): void {
	if (interactiveConsoleState) {
		return;
	}
	interactiveConsoleState = {
		error: console.error,
		info: console.info,
		warn: console.warn,
	};
	const writeHiddenConsoleDiagnostic = (...data: unknown[]) => {
		process.stderr.write(`${format(...data)}\n`);
	};
	for (const level of consoleLevels) {
		replaceConsoleMethod(level, writeHiddenConsoleDiagnostic);
	}
}

function restoreInteractiveConsole(): void {
	if (!interactiveConsoleState) {
		return;
	}
	for (const level of consoleLevels) {
		replaceConsoleMethod(level, interactiveConsoleState[level]);
	}
	interactiveConsoleState = undefined;
}

/** Load the fd-level capture once, before the first takeover; a no-op where it is unsupported. */
export async function prepareInteractiveStderrCapture(): Promise<void> {
	stderrFdSyscalls ??= await loadStderrFdSyscalls().catch(() => undefined);
}

function takeOverStderrFd(): void {
	if (!stderrFdSyscalls || stderrFdRedirect) return;
	try {
		appendHiddenInteractiveStderr("native stderr (fd 2) captured below until the TUI releases the terminal");
		stderrFdRedirect = redirectStderrFd(stderrFdSyscalls, getDebugLogPath());
	} catch {
		stderrFdRedirect = undefined;
	}
}

// Only a terminal stdout is the TUI's screen; a piped stdout is some caller's protocol and stays as it is.
function takeOverStdoutFd(): void {
	if (!stderrFdSyscalls || stdoutFdRedirect || !process.stdout.isTTY) return;
	try {
		appendHiddenInteractiveStderr(
			"native stdout (fd 1) writes outside the TUI captured below until it releases the terminal",
		);
		stdoutFdRedirect = redirectStdoutFd(stderrFdSyscalls, getDebugLogPath());
	} catch {
		stdoutFdRedirect = undefined;
	}
}

function startHiddenOutputCap(): void {
	if (hiddenOutputCapTimer || (!stderrFdRedirect && !stdoutFdRedirect)) return;
	hiddenOutputCapTimer = setInterval(() => {
		try {
			capHiddenOutputLog(getDebugLogPath());
		} catch {
			// The cap is best effort; a failed check retries on the next tick.
		}
	}, HIDDEN_OUTPUT_CAP_CHECK_MS);
	hiddenOutputCapTimer.unref?.();
}

function restoreStderrFd(): void {
	if (hiddenOutputCapTimer) clearInterval(hiddenOutputCapTimer);
	hiddenOutputCapTimer = undefined;
	stdoutFdRedirect?.restore();
	stdoutFdRedirect = undefined;
	stderrFdRedirect?.restore();
	stderrFdRedirect = undefined;
}

export function takeOverInteractiveStderr(): void {
	takeOverStderr(appendHiddenInteractiveStderr, redactSensitiveOutput);
	takeOverInteractiveConsole();
	takeOverStderrFd();
	takeOverStdoutFd();
	startHiddenOutputCap();
}

export function restoreInteractiveStderr(): void {
	restoreStderrFd();
	restoreInteractiveConsole();
	restoreStderr();
}
