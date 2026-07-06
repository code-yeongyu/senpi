import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BridgeConnectionConfig, HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { decodeBridgeFrame, encodeBridgeFrame } from "../../bridge/protocol.ts";

export interface KernelRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export interface SubprocessLike {
	readonly stdin: { write(chunk: string): unknown };
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	kill(signal?: NodeJS.Signals): boolean;
}

export type SubprocessSpawn = (
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => SubprocessLike;

export interface SubprocessKernelOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}

export class SubprocessKernel {
	private process!: SubprocessLike;
	private readonly options: SubprocessKernelOptions;
	private readonly onMessage?: (message: KernelToHostMessage) => void;
	private readonly pendingRuns = new Map<
		string,
		{ readonly resolve: (message: KernelResult) => void; readonly timer: NodeJS.Timeout | null }
	>();
	private readonly retiringProcesses = new WeakSet<SubprocessLike>();
	private readonly pendingCalls: ToolCallMessage[] = [];
	private readonly callWaiters: ((message: ToolCallMessage) => void)[] = [];
	private closed = false;

	constructor(options: SubprocessKernelOptions) {
		this.options = options;
		this.onMessage = options.onMessage;
		this.process = this.spawnProcess();
	}

	run(input: KernelRunInput): Promise<KernelResult> {
		if (this.closed) throw new Error("Kernel is closed");
		const message: HostToKernelMessage = {
			type: "run",
			cellId: input.cellId,
			code: input.code,
			timeoutMs: input.timeoutMs,
		};
		this.send(message);
		return new Promise((resolve) => {
			const timeoutMs = input.timeoutMs;
			const timer =
				timeoutMs === undefined
					? null
					: setTimeout(() => {
							this.pendingRuns.delete(input.cellId);
							resolve({
								type: "result",
								cellId: input.cellId,
								ok: false,
								error: { message: `Cell timed out after ${timeoutMs}ms` },
								durationMs: timeoutMs,
							});
							this.restartProcess();
						}, timeoutMs);
			this.pendingRuns.set(input.cellId, { resolve, timer });
		});
	}

	nextToolCall(): Promise<ToolCallMessage> {
		const queued = this.pendingCalls.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => this.callWaiters.push(resolve));
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		this.send(message);
	}

	async reset(): Promise<void> {
		this.restartProcess();
		this.pendingRuns.clear();
		this.pendingCalls.length = 0;
		this.callWaiters.length = 0;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.send({ type: "close" });
		this.process.kill("SIGTERM");
	}

	private attachReaders(): void {
		const activeProcess = this.process;
		const stdout = createInterface({ input: this.process.stdout });
		stdout.on("line", (line) => {
			if (this.process !== activeProcess) return;
			this.handleLine(`${line}\n`);
		});
		this.process.stderr.on("data", (chunk) => {
			if (this.process !== activeProcess) return;
			this.handleMessage({ type: "text", stream: "stderr", data: String(chunk) });
		});
		this.process.once("exit", (code, signal) => {
			if (this.retiringProcesses.has(activeProcess)) return;
			if (this.process !== activeProcess) return;
			this.closed = true;
			const error = { message: `Kernel exited before completing the cell (${signal ?? code ?? "unknown"})` };
			for (const [cellId, pending] of this.pendingRuns) {
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve({ type: "result", cellId, ok: false, error, durationMs: 0 });
			}
			this.pendingRuns.clear();
		});
	}

	private handleLine(line: string): void {
		const decoded = decodeBridgeFrame(line);
		if (!decoded.ok) {
			this.handleMessage({ type: "text", stream: "stderr", data: `${decoded.error.message}\n` });
			return;
		}
		this.handleMessage(decoded.message as KernelToHostMessage);
	}

	private handleMessage(message: KernelToHostMessage): void {
		this.onMessage?.(message);
		if (message.type === "tool-call") {
			const waiter = this.callWaiters.shift();
			if (waiter) waiter(message);
			else this.pendingCalls.push(message);
			return;
		}
		if (message.type === "result") {
			const pending = this.pendingRuns.get(message.cellId);
			if (pending?.timer) clearTimeout(pending.timer);
			pending?.resolve(message);
			this.pendingRuns.delete(message.cellId);
		}
	}

	private send(message: HostToKernelMessage): void {
		this.process.stdin.write(encodeBridgeFrame(message));
	}

	private restartProcess(): void {
		const activeProcess = this.process;
		this.retiringProcesses.add(activeProcess);
		this.process = this.spawnProcess();
		activeProcess.kill("SIGTERM");
	}

	private spawnProcess(): SubprocessLike {
		const spawn = this.options.spawn ?? defaultSpawn;
		this.closed = false;
		const child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: this.options.env });
		this.process = child;
		this.attachReaders();
		this.send({ type: "init", sessionId: this.options.sessionId, connection: this.options.connection });
		return child;
	}
}

function defaultSpawn(
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
): SubprocessLike {
	return nodeSpawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: "pipe",
	}) as ChildProcessWithoutNullStreams;
}
