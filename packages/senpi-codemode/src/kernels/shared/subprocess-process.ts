import { spawn as nodeSpawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

export interface SubprocessLike {
	readonly pid?: number;
	readonly stdin: { write(chunk: string): unknown };
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	on(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	removeListener(event: "error", listener: (error: Error) => void): this;
	kill(signal?: NodeJS.Signals): boolean;
}

export type SubprocessSpawn = (
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => SubprocessLike;

export interface SubprocessSpawnRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

interface SubprocessProcessHandlers {
	readonly onLine: (process: SubprocessProcess, line: string) => void;
	readonly onStderr: (process: SubprocessProcess, data: string) => void;
	readonly onExit: (process: SubprocessProcess, code: number | null, signal: NodeJS.Signals | null) => void;
	readonly onError: (process: SubprocessProcess, error: Error) => void;
}

export type SubprocessTermination =
	| { readonly ok: true; readonly exited: boolean }
	| { readonly ok: false; readonly error: Error };

const gracefulExitWaitMs = 1_500;
const forcedExitWaitMs = 500;

export class SubprocessProcess {
	readonly child: SubprocessLike;
	private readonly handlers: SubprocessProcessHandlers;
	private readonly exit = Promise.withResolvers<void>();
	private readonly stdoutReader: ReadlineInterface;
	private readonly stderrListener: (chunk: string | Buffer) => void;
	private readonly errorListener: (error: Error) => void;
	private exited = false;
	private retiring = false;
	private outputDetached = false;
	private errorReported = false;
	private terminationPromise: Promise<boolean> | null = null;

	constructor(child: SubprocessLike, handlers: SubprocessProcessHandlers) {
		this.child = child;
		this.handlers = handlers;
		this.stdoutReader = createInterface({ input: child.stdout });
		this.stderrListener = (chunk) => {
			if (!this.retiring) this.handlers.onStderr(this, String(chunk));
		};
		this.errorListener = (error) => {
			if (this.errorReported) return;
			this.errorReported = true;
			this.handlers.onError(this, error);
		};
		this.stdoutReader.on("line", (line) => {
			if (!this.retiring) this.handlers.onLine(this, `${line}\n`);
		});
		child.stderr.on("data", this.stderrListener);
		child.on("error", this.errorListener);
		child.once("exit", (code, signal) => {
			this.exited = true;
			this.detachOutput();
			child.removeListener("error", this.errorListener);
			this.exit.resolve();
			this.handlers.onExit(this, code, signal);
		});
	}

	get isRetiring(): boolean {
		return this.retiring;
	}

	send(frame: string): boolean {
		if (this.retiring) return false;
		this.child.stdin.write(frame);
		return true;
	}

	retire(): void {
		if (this.retiring) return;
		this.retiring = true;
		this.detachOutput();
	}

	terminate(initialSignal: NodeJS.Signals = "SIGTERM", escalationMs = gracefulExitWaitMs): Promise<boolean> {
		if (this.terminationPromise) return this.terminationPromise;
		this.terminationPromise = this.performTermination(initialSignal, escalationMs);
		return this.terminationPromise;
	}

	async terminateSafely(initialSignal?: NodeJS.Signals, escalationMs?: number): Promise<SubprocessTermination> {
		try {
			return { ok: true, exited: await this.terminate(initialSignal, escalationMs) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	async shutdown(frame?: string): Promise<boolean> {
		if (frame !== undefined) {
			try {
				this.send(frame);
			} catch (error) {
				if (!(error instanceof Error)) throw error;
			}
		}
		this.retire();
		return await this.terminate();
	}

	private async performTermination(initialSignal: NodeJS.Signals, escalationMs: number): Promise<boolean> {
		this.retire();
		if (this.exited) return true;
		this.kill(initialSignal);
		if (await this.waitForExit(escalationMs)) return true;
		this.kill("SIGKILL");
		return await this.waitForExit(forcedExitWaitMs);
	}

	private async waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.exited) return true;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		try {
			return await Promise.race([this.exit.promise.then(() => true as const), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private detachOutput(): void {
		if (this.outputDetached) return;
		this.outputDetached = true;
		this.stdoutReader.close();
		this.child.stderr.removeListener("data", this.stderrListener);
	}

	private kill(signal: NodeJS.Signals): void {
		if (this.child.pid !== undefined) {
			try {
				globalThis.process.kill(-this.child.pid, signal);
				return;
			} catch (error) {
				if (!(error instanceof Error)) throw error;
			}
		}
		this.child.kill(signal);
	}
}

export function spawnSubprocess(spawn: SubprocessSpawn | undefined, request: SubprocessSpawnRequest): SubprocessLike {
	if (spawn) return spawn(request.command, request.args, { cwd: request.cwd, env: request.env });
	return nodeSpawn(request.command, [...request.args], {
		cwd: request.cwd,
		detached: true,
		env: request.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
}
