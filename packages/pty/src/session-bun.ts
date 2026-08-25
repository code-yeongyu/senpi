import { Buffer } from "node:buffer";
import process from "node:process";
import type {
	TerminalSessionDataHandler,
	TerminalSessionHandle,
	TerminalSessionNativeOptions,
	TerminalSessionOperationResult,
	TerminalSessionSignal,
} from "./session-types.ts";

export interface BunTerminal {
	readonly write: (data: string | Uint8Array) => void;
	readonly resize: (cols: number, rows: number) => void;
}

interface BunSubprocess {
	readonly terminal: BunTerminal;
	readonly exited: Promise<number>;
	kill: (signal?: TerminalSessionSignal) => void;
}

interface BunSpawnOptions {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly terminal: {
		readonly cols: number;
		readonly rows: number;
		readonly data: (terminal: BunTerminal, data: Uint8Array) => void;
	};
}

export interface BunRuntimeVersions {
	readonly bun?: unknown;
}

export interface BunRuntime {
	readonly spawn: (command: readonly string[], options: BunSpawnOptions) => BunSubprocess;
}

const BUN_TERMINAL_NOTE = "Used Bun.spawn terminal backend.";

export const ENV_BUN_TERMINAL = "SENPI_BUN_TERMINAL";

export function isBunTerminalEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
	versions: BunRuntimeVersions = process.versions as BunRuntimeVersions,
): boolean {
	if (typeof versions.bun !== "string") return false;
	const value = env[ENV_BUN_TERMINAL];
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function createBunTerminalSession(
	options: TerminalSessionNativeOptions,
	onData: TerminalSessionDataHandler,
	runtime: BunRuntime = getBunRuntime(),
): TerminalSessionHandle {
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error("Invalid timeoutMs: must be a finite positive number");
	}
	const child = runtime.spawn([options.command, ...options.args], {
		cwd: options.cwd,
		env: options.env ? mergeEnvironment(options.env) : undefined,
		terminal: {
			cols: options.cols,
			rows: options.rows,
			data: (_terminal, data) => onData(Buffer.from(data)),
		},
	});
	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const exitPromise = child.exited.then((exitCode) => {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		return { exitCode, signal: null, timedOut };
	});

	if (options.timeoutMs !== undefined) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, options.timeoutMs);
	}

	return {
		write(data) {
			child.terminal.write(data);
			return { ok: true, note: BUN_TERMINAL_NOTE } satisfies TerminalSessionOperationResult;
		},
		resize(cols, rows) {
			child.terminal.resize(cols, rows);
			return { ok: true, note: `Resized Bun terminal session to ${cols}x${rows}.` };
		},
		kill(signal = "SIGTERM") {
			child.kill(signal);
			return { ok: true, note: `Sent ${signal} to Bun terminal session.` };
		},
		waitExit: async () => await exitPromise,
	};
}

function mergeEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) merged[key] = value;
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete merged[key];
		else merged[key] = value;
	}
	return merged;
}

function getBunRuntime(): BunRuntime {
	const runtime = (globalThis as { readonly Bun?: BunRuntime }).Bun;
	if (!runtime) throw new Error("Bun terminal backend is only available in Bun runtimes");
	return runtime;
}
