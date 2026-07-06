import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type BridgeConnectionConfig,
	decodeBridgeFrame,
	encodeBridgeFrame,
	type HostToKernelMessage,
	type KernelToHostMessage,
} from "../../bridge/protocol.ts";

export interface KernelChild {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly pid?: number;
	readonly killed: boolean;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: string, listener: (...args: unknown[]) => void): this;
	once(event: string, listener: (...args: unknown[]) => void): this;
	off(event: string, listener: (...args: unknown[]) => void): this;
}

export interface KernelSpawnOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}
export type KernelSpawnProcess = (options: KernelSpawnOptions) => KernelChild;
export interface PythonKernelStartOptions {
	readonly interpreterPath: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly connection: BridgeConnectionConfig;
	readonly env?: NodeJS.ProcessEnv;
	readonly startupTimeoutMs?: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly spawnProcess?: KernelSpawnProcess;
}
export interface PythonKernelRunOptions {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}
type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;
const startupTimeoutMs = 5_000;

export class PythonKernel {
	readonly #options: PythonKernelStartOptions;
	#child: KernelChild | null = null;
	#stdoutBuffer = "";
	#stderrTail = "";
	#settleReady: ((error?: Error) => void) | null = null;
	#pending = new Map<string, (result: ResultMessage) => void>();

	private constructor(options: PythonKernelStartOptions) {
		this.#options = options;
	}

	static async start(options: PythonKernelStartOptions): Promise<PythonKernel> {
		const kernel = new PythonKernel(options);
		await kernel.#spawn();
		return kernel;
	}

	async run(options: PythonKernelRunOptions): Promise<ResultMessage> {
		await this.#ensureStarted();
		return await new Promise<ResultMessage>((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(options.cellId);
				void this.#kill();
				resolve({
					type: "result",
					cellId: options.cellId,
					ok: false,
					error: { message: `Python kernel timed out after ${options.timeoutMs ?? 0}ms` },
					durationMs: options.timeoutMs ?? 0,
				});
			}, options.timeoutMs ?? 30_000);
			this.#pending.set(options.cellId, (result) => {
				clearTimeout(timer);
				resolve(result);
			});
			this.#write({ type: "run", cellId: options.cellId, code: options.code, timeoutMs: options.timeoutMs });
		});
	}

	async interrupt(reason = "interrupted"): Promise<void> {
		if (!this.#child) return;
		this.#write({ type: "interrupt", reason });
		if (process.platform === "win32") this.#child.kill();
		else this.#child.kill("SIGINT");
	}

	async reset(): Promise<void> {
		await this.#kill();
		await this.#spawn();
	}

	async close(): Promise<void> {
		const child = this.#child;
		if (!child) return;
		this.#write({ type: "close" });
		await Promise.race([onceExit(child), delay(500)]);
		if (!child.killed) await this.#kill();
		this.#child = null;
	}

	async #ensureStarted(): Promise<void> {
		if (this.#child && !this.#child.killed) return;
		await this.#spawn();
	}

	async #spawn(): Promise<void> {
		const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "prelude.py");
		const invocation = splitCommand(this.#options.interpreterPath);
		const spawnOptions: KernelSpawnOptions = {
			command: invocation.command,
			args: [...invocation.args, "-u", scriptPath],
			cwd: this.#options.cwd,
			env: { ...process.env, ...this.#options.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
		};
		const child = (this.#options.spawnProcess ?? defaultSpawn)(spawnOptions);
		this.#child = child;
		this.#stdoutBuffer = "";
		this.#stderrTail = "";
		const ready = new Promise<void>((resolve, reject) => {
			this.#settleReady = (error) => (error ? reject(error) : resolve());
		});
		child.stdout.on("data", (chunk) => this.#onStdout(String(chunk)));
		child.stderr.on("data", (chunk) => this.#onStderr(String(chunk)));
		child.once("exit", (code, signal) => this.#onExit(numberOrNull(code), signalOrNull(signal)));
		this.#write({ type: "init", sessionId: this.#options.sessionId, connection: this.#options.connection });
		await withTimeout(
			ready,
			this.#options.startupTimeoutMs ?? startupTimeoutMs,
			"Python kernel did not become ready",
		);
	}

	#write(message: HostToKernelMessage): void {
		this.#child?.stdin.write(encodeBridgeFrame(message));
	}

	#onStdout(chunk: string): void {
		this.#stdoutBuffer += chunk;
		let newline = this.#stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#stdoutBuffer.slice(0, newline + 1);
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			this.#handleLine(line);
			newline = this.#stdoutBuffer.indexOf("\n");
		}
	}

	#onStderr(chunk: string): void {
		this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4_000);
		this.#emit({ type: "text", stream: "stderr", data: chunk });
	}

	#handleLine(line: string): void {
		const decoded = decodeBridgeFrame(line);
		if (!decoded.ok) {
			this.#emit({ type: "text", stream: "stderr", data: `${decoded.error.message}\n` });
			return;
		}
		const message = decoded.message as KernelToHostMessage;
		if (message.type === "ready") this.#settleReady?.();
		else if (message.type === "init-failed") this.#settleReady?.(new Error(message.error.message));
		else if (message.type === "result") this.#pending.get(message.cellId)?.(message);
		this.#emit(message);
	}

	#onExit(code: number | null, signal: NodeJS.Signals | null): void {
		const error = new Error(this.#stderrTail.trim() || `Python kernel exited (${code ?? signal ?? "unknown"})`);
		this.#settleReady?.(error);
		for (const [cellId, settle] of this.#pending) {
			settle({
				type: "result",
				cellId,
				ok: false,
				error: { message: "Python kernel died", stack: error.message },
				durationMs: 0,
			});
		}
		this.#pending.clear();
		this.#child = null;
	}

	#emit(message: KernelToHostMessage): void {
		this.#options.onMessage?.(message);
	}

	async #kill(): Promise<void> {
		const child = this.#child;
		if (!child) return;
		if (child.pid !== undefined && process.platform !== "win32") {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		} else {
			child.kill("SIGKILL");
		}
		await Promise.race([onceExit(child), delay(500)]);
		this.#child = null;
	}
}

function defaultSpawn(options: KernelSpawnOptions): KernelChild {
	return spawn(options.command, [...options.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: "pipe",
		detached: process.platform !== "win32",
		windowsHide: true,
	});
}

function splitCommand(commandLine: string): { readonly command: string; readonly args: readonly string[] } {
	const [command, ...args] = commandLine.split(" ").filter(Boolean);
	if (!command) throw new Error("Python interpreter path is empty");
	return { command, args };
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function signalOrNull(value: unknown): NodeJS.Signals | null {
	return typeof value === "string" ? (value as NodeJS.Signals) : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function onceExit(child: KernelChild): Promise<void> {
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
