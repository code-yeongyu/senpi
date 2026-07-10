import type { BridgeConnectionConfig, HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { decodeBridgeFrame, encodeBridgeFrame, isKernelToHostMessage } from "../../bridge/protocol.ts";
import { type SubprocessLike, SubprocessProcess, type SubprocessSpawn, spawnSubprocess } from "./subprocess-process.ts";
import {
	CellInterruptedError,
	createPendingRun,
	failureResult,
	KernelClosedError,
	KernelClosingError,
	KernelExitedError,
	KernelProcessError,
	KernelResetError,
	KernelRetirementError,
	KernelStartupError,
	type PendingRun,
	settlePendingRun,
	timeoutResult,
} from "./subprocess-run.ts";

export type { SubprocessLike, SubprocessSpawn };

export interface KernelRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

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
	private readonly options: SubprocessKernelOptions;
	private readonly onMessage?: (message: KernelToHostMessage) => void;
	private readonly runQueue: PendingRun[] = [];
	private readonly pendingCalls: ToolCallMessage[] = [];
	private readonly callWaiters: ((message: ToolCallMessage) => void)[] = [];
	private process: SubprocessProcess | null = null;
	private activeRun: PendingRun | null = null;
	private retirementPromise: Promise<void> | null = null;
	private failure: Error | null = null;
	private closed = false;

	constructor(options: SubprocessKernelOptions) {
		this.options = options;
		this.onMessage = options.onMessage;
		this.spawnProcess();
	}

	run(input: KernelRunInput): Promise<KernelResult> {
		if (this.closed) throw new KernelClosedError();
		return new Promise((resolve) => {
			this.runQueue.push(createPendingRun(input, resolve));
			this.pumpRuns();
		});
	}

	async interrupt(reason = "interrupted"): Promise<void> {
		if (this.closed || !this.activeRun) return;
		const process = this.process;
		process?.retire();
		this.pendingCalls.length = 0;
		const run = this.activeRun;
		this.activeRun = null;
		this.settleRun(run, failureResult(run, new CellInterruptedError(reason)));
		const signal = globalThis.process.platform === "win32" ? "SIGTERM" : "SIGINT";
		await this.restartProcess(process, signal, 5_000);
	}

	nextToolCall(): Promise<ToolCallMessage> {
		const queued = this.pendingCalls.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => this.callWaiters.push(resolve));
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		this.process?.send(encodeBridgeFrame(message));
	}

	async reset(): Promise<void> {
		if (this.closed) throw new KernelClosedError();
		this.settleAll(new KernelResetError());
		this.pendingCalls.length = 0;
		this.callWaiters.length = 0;
		await this.restartProcess(this.process);
		if (this.failure) throw this.failure;
	}

	async close(): Promise<void> {
		const wasClosed = this.closed;
		this.closed = true;
		if (!wasClosed) {
			this.settleAll(new KernelClosingError());
			this.pendingCalls.length = 0;
			this.callWaiters.length = 0;
		}
		if (this.retirementPromise) return this.retirementPromise;
		const process = this.process;
		if (!process) return;
		const closeFrame = wasClosed ? undefined : encodeBridgeFrame({ type: "close" });
		if (await process.shutdown(closeFrame)) this.process = null;
	}

	private pumpRuns(): void {
		const process = this.process;
		if (this.closed || this.activeRun || !process || process.isRetiring) return;
		const run = this.runQueue.shift();
		if (!run) return;
		this.activeRun = run;
		run.startedAt = performance.now();
		const timeoutMs = run.input.timeoutMs;
		if (timeoutMs !== undefined) run.timer = setTimeout(() => this.handleTimeout(run, timeoutMs), timeoutMs);
		try {
			process.send(encodeBridgeFrame({ type: "run", cellId: run.input.cellId, code: run.input.code, timeoutMs }));
		} catch (error) {
			this.failClosed(new KernelProcessError(error instanceof Error ? error.message : String(error)));
		}
	}

	private handleTimeout(run: PendingRun, timeoutMs: number): void {
		if (this.activeRun !== run || run.settled) return;
		const process = this.process;
		process?.retire();
		this.pendingCalls.length = 0;
		this.activeRun = null;
		this.settleRun(run, timeoutResult(run, timeoutMs));
		void this.restartProcess(process);
	}

	private spawnProcess(): void {
		const child = spawnSubprocess(this.options.spawn, this.options);
		const process = new SubprocessProcess(child, {
			onLine: (source, line) => this.handleLine(source, line),
			onStderr: (source, data) => this.handleMessage(source, { type: "text", stream: "stderr", data }),
			onExit: (source, code, signal) => this.handleExit(source, code, signal),
			onError: (source, error) => {
				if (this.accepts(source)) this.failClosed(new KernelProcessError(error.message));
			},
		});
		this.process = process;
		process.send(
			encodeBridgeFrame({ type: "init", sessionId: this.options.sessionId, connection: this.options.connection }),
		);
	}

	private handleLine(process: SubprocessProcess, line: string): void {
		if (!this.accepts(process)) return;
		const decoded = decodeBridgeFrame(line);
		if (!decoded.ok) {
			this.handleMessage(process, { type: "text", stream: "stderr", data: `${decoded.error.message}\n` });
			return;
		}
		if (isKernelToHostMessage(decoded.message)) this.handleMessage(process, decoded.message);
	}

	private handleMessage(process: SubprocessProcess, message: KernelToHostMessage): void {
		if (!this.accepts(process)) return;
		switch (message.type) {
			case "result": {
				const run = this.activeRun;
				if (!run || run.input.cellId !== message.cellId) return;
				this.onMessage?.(message);
				this.activeRun = null;
				this.settleRun(run, message);
				this.pumpRuns();
				return;
			}
			case "tool-call": {
				if (!this.activeRun) return;
				this.onMessage?.(message);
				const waiter = this.callWaiters.shift();
				if (waiter) waiter(message);
				else this.pendingCalls.push(message);
				return;
			}
			case "text":
			case "display":
			case "log":
			case "phase":
				if (this.activeRun) this.onMessage?.(message);
				return;
			case "ready":
			case "init-failed":
			case "closed":
				this.onMessage?.(message);
				return;
		}
	}

	private handleExit(process: SubprocessProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (process.isRetiring || this.process !== process) return;
		this.process = null;
		this.failClosed(new KernelExitedError(signal ?? code ?? "unknown"));
	}

	private accepts(process: SubprocessProcess): boolean {
		return !this.closed && this.process === process && !process.isRetiring;
	}

	private restartProcess(
		process: SubprocessProcess | null,
		initialSignal: NodeJS.Signals = "SIGTERM",
		escalationMs = 1_500,
	): Promise<void> {
		if (!process || this.closed) return Promise.resolve();
		if (this.retirementPromise) return this.retirementPromise;
		process.retire();
		const retirement = this.replaceAfterRetirement(process, initialSignal, escalationMs);
		this.retirementPromise = retirement;
		void retirement.finally(() => {
			if (this.retirementPromise === retirement) this.retirementPromise = null;
		});
		return retirement;
	}

	private async replaceAfterRetirement(
		process: SubprocessProcess,
		initialSignal: NodeJS.Signals,
		escalationMs: number,
	): Promise<void> {
		const termination = await process.terminateSafely(initialSignal, escalationMs);
		if (!termination.ok) {
			this.failClosed(new KernelProcessError(termination.error.message));
			return;
		}
		if (!termination.exited) {
			this.failClosed(new KernelRetirementError());
			return;
		}
		if (this.process === process) this.process = null;
		if (this.closed) return;
		try {
			this.spawnProcess();
		} catch (error) {
			this.failClosed(new KernelStartupError(error instanceof Error ? error.message : String(error)));
			return;
		}
		this.pumpRuns();
	}

	private settleRun(run: PendingRun, result: KernelResult): void {
		if (settlePendingRun(run, result) && this.activeRun === run) this.activeRun = null;
	}

	private settleAll(error: Error): void {
		const runs = this.activeRun ? [this.activeRun, ...this.runQueue] : [...this.runQueue];
		this.activeRun = null;
		this.runQueue.length = 0;
		for (const run of runs) this.settleRun(run, failureResult(run, error));
	}

	private failClosed(error: Error): void {
		const process = this.process;
		this.failure = error;
		this.closed = true;
		process?.retire();
		this.pendingCalls.length = 0;
		this.settleAll(error);
		if (!process || this.retirementPromise) return;
		this.retirementPromise = process.terminateSafely().then((termination) => {
			if (termination.ok && termination.exited && this.process === process) this.process = null;
		});
	}
}
