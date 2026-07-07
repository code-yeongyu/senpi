import process from "node:process";
import type { PipeFallbackSessionOptions } from "./pipe-fallback.ts";
import type { TerminalSessionNativeOptions, TerminalSessionOptions } from "./session-types.ts";

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_RAW_TAIL_BYTES = 64 * 1024;

export function normalizeRawTailBytes(value: number | undefined): number {
	if (value === undefined) return DEFAULT_RAW_TAIL_BYTES;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("Invalid rawTailBytes: must be a non-negative safe integer");
	}
	return value;
}

export function defaultCommand(): string {
	if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
	return process.env.SHELL ?? "sh";
}

export function toNativeOptions(options: TerminalSessionOptions): TerminalSessionNativeOptions {
	return {
		command: options.command ?? defaultCommand(),
		args: [...(options.args ?? [])],
		cwd: options.cwd,
		env: options.env ? { ...options.env } : undefined,
		cols: options.cols ?? DEFAULT_COLS,
		rows: options.rows ?? DEFAULT_ROWS,
		timeoutMs: options.timeoutMs,
	};
}

export function toPipeFallbackOptions(options: TerminalSessionOptions): PipeFallbackSessionOptions {
	return {
		command: options.command ?? defaultCommand(),
		args: options.args ? [...options.args] : undefined,
		cwd: options.cwd,
		env: options.env ? { ...options.env } : undefined,
		timeoutMs: options.timeoutMs,
	};
}
