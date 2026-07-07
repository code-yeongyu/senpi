import { spawn } from "node:child_process";
import type { NativePtyLoadResult } from "./native-loader.ts";

export interface PipeFallbackSessionOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly timeoutMs?: number;
}

export interface PipeFallbackSessionError {
	readonly code: "spawn_error";
	readonly message: string;
}

export interface PipeFallbackSessionExit {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	readonly error?: PipeFallbackSessionError;
}

export type PipeFallbackOperationResult =
	| {
			readonly ok: true;
			readonly note: string;
	  }
	| {
			readonly ok: false;
			readonly code: "exited" | "not_pty" | "not_started" | "stdin_unavailable";
			readonly note: string;
	  };

type ChildProcessHandle = ReturnType<typeof spawn>;
type DataHandler = (chunk: Buffer) => void;
type ExitHandler = (exit: PipeFallbackSessionExit) => void;

const PIPE_FALLBACK_NOTE =
	"Running with child_process pipe fallback because no PTY backend is active; terminal screen state and resize are unavailable.";

export function isPipeFallbackForced(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	const value = env.SENPI_PTY_FORCE_PIPE;
	return value === "1" || value === "true";
}

export function shouldUsePipeFallback(
	nativeLoadResult: NativePtyLoadResult,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return isPipeFallbackForced(env) || nativeLoadResult.native === null;
}

function normalizeSpawnError(command: string, error: Error): PipeFallbackSessionError {
	return {
		code: "spawn_error",
		message: `Failed to spawn pipe fallback command "${command}": ${error.message}`,
	};
}

function toBuffer(chunk: string | Buffer): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function validateTimeout(timeoutMs: number | undefined): void {
	if (timeoutMs === undefined) return;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Invalid timeoutMs: must be a finite positive number");
	}
}

export class PipeFallbackSession {
	readonly backend = "pipe-fallback";
	readonly note = PIPE_FALLBACK_NOTE;
	readonly options: PipeFallbackSessionOptions;
	private child: ChildProcessHandle | null = null;
	private exitResult: PipeFallbackSessionExit | null = null;
	private exitPromise: Promise<PipeFallbackSessionExit>;
	private resolveExit: ((exit: PipeFallbackSessionExit) => void) | null = null;
	private spawnError: PipeFallbackSessionError | undefined;
	private timedOut = false;
	private timeoutHandle: NodeJS.Timeout | undefined;
	private readonly dataHandlers = new Set<DataHandler>();
	private readonly exitHandlers = new Set<ExitHandler>();

	constructor(options: PipeFallbackSessionOptions) {
		this.options = {
			...options,
			args: options.args ? [...options.args] : undefined,
			env: options.env ? { ...options.env } : undefined,
		};
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	start(): this {
		if (this.exitResult !== null) throw new Error("Cannot restart exited pipe fallback session");
		if (this.child !== null) throw new Error("Pipe fallback session has already been started");
		validateTimeout(this.options.timeoutMs);

		try {
			const child = spawn(this.options.command, [...(this.options.args ?? [])], {
				cwd: this.options.cwd,
				env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			this.child = child;
			child.stdout?.on("data", (chunk: string | Buffer) => this.emitData(toBuffer(chunk)));
			child.stderr?.on("data", (chunk: string | Buffer) => this.emitData(toBuffer(chunk)));
			child.stdin?.on("error", () => {});
			child.on("error", (error: Error) => {
				this.spawnError = normalizeSpawnError(this.options.command, error);
			});
			child.on("close", (exitCode, signal) => {
				this.settleExit({
					exitCode: this.spawnError ? null : exitCode,
					signal,
					timedOut: this.timedOut,
					error: this.spawnError,
				});
			});
			if (this.options.timeoutMs !== undefined) {
				this.timeoutHandle = setTimeout(() => {
					this.timedOut = true;
					child.kill("SIGTERM");
				}, this.options.timeoutMs);
			}
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			this.settleExit({
				exitCode: null,
				signal: null,
				timedOut: false,
				error: normalizeSpawnError(this.options.command, cause),
			});
		}
		return this;
	}

	onData(handler: DataHandler): () => void {
		this.dataHandlers.add(handler);
		return () => this.dataHandlers.delete(handler);
	}

	onExit(handler: ExitHandler): () => void {
		const exitResult = this.exitResult;
		if (exitResult !== null) queueMicrotask(() => handler(exitResult));
		else this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	write(data: string | Uint8Array): PipeFallbackOperationResult {
		if (this.exitResult !== null) {
			return { ok: false, code: "exited", note: "Cannot write to pipe fallback stdin: session has exited." };
		}
		if (this.child === null) {
			return {
				ok: false,
				code: "not_started",
				note: "Cannot write to pipe fallback stdin: session has not started.",
			};
		}
		if (!this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
			return {
				ok: false,
				code: "stdin_unavailable",
				note: "Cannot write to pipe fallback stdin: child stdin is unavailable.",
			};
		}
		const accepted = this.child.stdin.write(data);
		return {
			ok: true,
			note: accepted
				? "Wrote stdin through child_process pipe fallback; this is not a PTY."
				: "Queued stdin through child_process pipe fallback with stream backpressure; this is not a PTY.",
		};
	}

	closeInput(): PipeFallbackOperationResult {
		if (this.exitResult !== null) {
			return { ok: false, code: "exited", note: "Cannot close pipe fallback stdin: session has exited." };
		}
		if (this.child === null) {
			return { ok: false, code: "not_started", note: "Cannot close pipe fallback stdin: session has not started." };
		}
		this.child.stdin?.end();
		return { ok: true, note: "Closed child_process pipe fallback stdin." };
	}

	resize(cols: number, rows: number): PipeFallbackOperationResult {
		return {
			ok: false,
			code: "not_pty",
			note: `Cannot resize pipe fallback session to ${cols}x${rows}: child_process pipes are not a PTY; session is still valid.`,
		};
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): PipeFallbackOperationResult {
		if (this.exitResult !== null) {
			return { ok: false, code: "exited", note: "Cannot kill pipe fallback session: session has exited." };
		}
		if (this.child === null) {
			return { ok: false, code: "not_started", note: "Cannot kill pipe fallback session: session has not started." };
		}
		const pid = this.child.pid;
		if (process.platform === "win32" && pid !== undefined) {
			// On Windows child.kill() TerminateProcess-es only the direct child, leaving
			// grandchildren (e.g. `sleep` under `bash.exe -c`) alive and holding the stdout
			// pipe open — so 'close' never fires and waitExit() hangs teardown. taskkill /T /F
			// terminates the whole tree so the pipe EOFs and the session settles.
			try {
				spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				return { ok: true, note: `Terminated child_process pipe fallback process tree (pid ${pid}).` };
			} catch {
				// Fall through to the direct kill if taskkill is unavailable.
			}
		}
		this.child.kill(signal);
		return { ok: true, note: `Sent ${signal} to child_process pipe fallback session.` };
	}

	waitExit(): Promise<PipeFallbackSessionExit> {
		return this.exitPromise;
	}

	private emitData(chunk: Buffer): void {
		for (const handler of this.dataHandlers) handler(chunk);
	}

	private settleExit(exit: PipeFallbackSessionExit): void {
		if (this.exitResult !== null) return;
		if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
		this.exitResult = exit;
		this.resolveExit?.(exit);
		for (const handler of this.exitHandlers) handler(exit);
		this.exitHandlers.clear();
	}
}

export function createPipeFallbackSession(options: PipeFallbackSessionOptions): PipeFallbackSession {
	return new PipeFallbackSession(options).start();
}
