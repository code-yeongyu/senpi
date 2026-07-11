import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { decodeBridgeFrame, encodeBridgeFrame, isKernelToHostMessage } from "../../bridge/protocol.ts";
import type { KernelResult, KernelRunInput, SubprocessKernelOptions, ToolCallMessage } from "./subprocess-contract.ts";
import { type SubprocessLike, SubprocessProcess, type SubprocessSpawn, spawnSubprocess } from "./subprocess-process.ts";
import { SubprocessRunQueue } from "./subprocess-queue.ts";
import {
	CellInterruptedError,
	failureResult,
	KernelClosedError,
	KernelClosingError,
	KernelExitedError,
	KernelProcessError,
	KernelResetError,
	KernelRetirementError,
	KernelStartupError,
	type PendingRun,
	timeoutResult,
} from "./subprocess-run.ts";

export type { KernelResult, KernelRunInput, SubprocessKernelOptions, ToolCallMessage } from "./subprocess-contract.ts";
export type { SubprocessLike, SubprocessSpawn };

export class SubprocessKernel {
	private readonly options: SubprocessKernelOptions;
	private readonly onMessage?: (message: KernelToHostMessage) => void;
	private readonly runs = new SubprocessRunQueue();
	private process: SubprocessProcess | null = null;
	private retirementPromise: Promise<void> | null = null;
	private retirementProcess: SubprocessProcess | null = null;
	private retirementFailure: Error | null = null;
	private failure: Error | null = null;
	private closed = false;

	constructor(options: SubprocessKernelOptions) {
		this.options = options;
		this.onMessage = options.onMessage;
		this.spawnProcess();
	}

	run(input: KernelRunInput): Promise<KernelResult> {
		if (this.closed) throw new KernelClosedError();
		const run = this.runs.enqueue(input);
		this.pumpRuns();
		return run;
	}

	async interrupt(reason = "interrupted"): Promise<void> {
		if (this.closed) return;
		if (!this.runs.active) {
			if (!this.retirementPromise) return;
			const queued = this.runs.takeWaiting();
			if (queued) this.runs.settle(queued, failureResult(queued, new CellInterruptedError(reason)));
			return;
		}
		const process = this.process;
		process?.retire();
		this.runs.clearToolCalls();
		const run = this.runs.active;
		if (!run) return;
		this.runs.releaseActive(run);
		this.runs.settle(run, failureResult(run, new CellInterruptedError(reason)));
		const signal = globalThis.process.platform === "win32" ? "SIGTERM" : "SIGINT";
		await this.restartProcess(process, signal, 5_000);
		if (this.failure) throw this.failure;
	}

	nextToolCall(): Promise<ToolCallMessage> {
		return this.runs.nextToolCall();
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		this.process?.send(encodeBridgeFrame(message));
	}

	async reset(): Promise<void> {
		if (this.closed) throw new KernelClosedError();
		this.settleAll(new KernelResetError());
		this.runs.clearToolCalls();
		await this.restartProcess(this.process);
		if (this.failure) throw this.failure;
	}

	async close(): Promise<void> {
		const wasClosed = this.closed;
		this.closed = true;
		if (!wasClosed) {
			this.settleAll(new KernelClosingError());
			this.runs.clearToolCalls();
		}
		if (this.retirementPromise) {
			await this.retirementPromise;
			if (this.retirementFailure) throw this.retirementFailure;
			return;
		}
		const process = this.process;
		if (!process) return;
		const closeFrame = wasClosed ? undefined : encodeBridgeFrame({ type: "close" });
		if (!(await process.shutdown(closeFrame))) {
			const error = new KernelRetirementError();
			this.retirementFailure = error;
			throw error;
		}
		if (this.process === process) this.process = null;
		this.retirementFailure = null;
	}

	private pumpRuns(): void {
		const process = this.process;
		if (this.closed || this.runs.active || !process || process.isRetiring) return;
		const run = this.runs.startNext(performance.now());
		if (!run) return;
		const timeoutMs = run.input.timeoutMs;
		if (timeoutMs !== undefined) run.timer = setTimeout(() => this.handleTimeout(run, timeoutMs), timeoutMs);
		try {
			process.send(encodeBridgeFrame({ type: "run", cellId: run.input.cellId, code: run.input.code, timeoutMs }));
		} catch (error) {
			this.failClosed(new KernelProcessError(error instanceof Error ? error.message : String(error)));
		}
	}

	private handleTimeout(run: PendingRun, timeoutMs: number): void {
		if (this.runs.active !== run || run.settled) return;
		const process = this.process;
		process?.retire();
		this.runs.clearToolCalls();
		this.runs.releaseActive(run);
		this.runs.settle(run, timeoutResult(run, timeoutMs));
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
		try {
			process.send(
				encodeBridgeFrame({ type: "init", sessionId: this.options.sessionId, connection: this.options.connection }),
			);
		} catch (error) {
			const failure = new KernelStartupError(error instanceof Error ? error.message : String(error));
			this.failClosed(failure);
			throw failure;
		}
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
		if (this.runs.handleMessage(message, this.onMessage)) this.pumpRuns();
	}

	private handleExit(process: SubprocessProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.process !== process) return;
		if (process.isRetiring) {
			this.process = null;
			this.retirementFailure = null;
			return;
		}
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
		return this.trackRetirement(process, retirement);
	}

	private async replaceAfterRetirement(
		process: SubprocessProcess,
		initialSignal: NodeJS.Signals,
		escalationMs: number,
	): Promise<void> {
		const termination = await process.terminateSafely(initialSignal, escalationMs);
		if (!termination.ok) {
			const error = new KernelProcessError(termination.error.message);
			this.retirementFailure = error;
			this.failClosed(error);
			return;
		}
		if (!termination.exited) {
			const error = new KernelRetirementError();
			this.retirementFailure = error;
			this.failClosed(error);
			return;
		}
		if (this.process === process) this.process = null;
		this.retirementFailure = null;
		if (this.closed) return;
		try {
			this.spawnProcess();
		} catch (error) {
			if (!(error instanceof KernelStartupError)) {
				this.failClosed(new KernelStartupError(error instanceof Error ? error.message : String(error)));
			}
			return;
		}
		this.pumpRuns();
	}

	private settleAll(error: Error): void {
		this.runs.settleAll(error);
	}

	private failClosed(error: Error): void {
		const process = this.process;
		this.failure = error;
		this.closed = true;
		process?.retire();
		this.runs.clearToolCalls();
		this.settleAll(error);
		if (!process || this.retirementProcess === process) return;
		this.trackRetirement(process, this.terminateOwnedProcess(process));
	}

	private async terminateOwnedProcess(process: SubprocessProcess): Promise<void> {
		const termination = await process.terminateSafely();
		if (!termination.ok) {
			this.retirementFailure = new KernelProcessError(termination.error.message);
			return;
		}
		if (!termination.exited) {
			this.retirementFailure = new KernelRetirementError();
			return;
		}
		if (this.process === process) this.process = null;
		this.retirementFailure = null;
	}

	private trackRetirement(process: SubprocessProcess, retirement: Promise<void>): Promise<void> {
		this.retirementProcess = process;
		this.retirementPromise = retirement;
		void retirement.then(() => {
			if (this.retirementPromise !== retirement) return;
			this.retirementPromise = null;
			this.retirementProcess = null;
		});
		return retirement;
	}
}
