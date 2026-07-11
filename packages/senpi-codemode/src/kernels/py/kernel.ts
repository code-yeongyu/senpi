import type { PendingRun, PythonKernelRunOptions, PythonKernelStartOptions, ResultMessage } from "./kernel-contract.ts";
import { failedPythonResult, PythonKernelTransport } from "./transport.ts";

export type { PythonKernelRunOptions, PythonKernelStartOptions } from "./kernel-contract.ts";
export type { KernelChild, KernelSpawnOptions, KernelSpawnProcess } from "./process.ts";

const startupTimeoutMs = 5_000;
const interruptEscalationMs = 5_000;

export class PythonKernel {
	readonly #options: PythonKernelStartOptions;
	#transport: PythonKernelTransport | null = null;
	#pending = new Map<string, PendingRun>();
	#queue: PendingRun[] = [];
	#active: PendingRun | null = null;
	#starting: Promise<void> | null = null;
	#retirement: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	#failure: Error | null = null;
	#generation = 0;
	#closed = false;

	private constructor(options: PythonKernelStartOptions) {
		this.#options = options;
	}

	static async start(options: PythonKernelStartOptions): Promise<PythonKernel> {
		const kernel = new PythonKernel(options);
		await kernel.#spawn(kernel.#generation);
		return kernel;
	}

	run(input: PythonKernelRunOptions): Promise<ResultMessage> {
		if (this.#failure) return Promise.reject(this.#failure);
		if (this.#closed) return Promise.reject(new Error("Python kernel is closed"));
		return new Promise<ResultMessage>((resolve, reject) => {
			const pending: PendingRun = { input, resolve, reject, startedAt: null, timeoutTimer: null };
			this.#pending.set(input.cellId, pending);
			this.#queue.push(pending);
			this.#startNext();
		});
	}

	async interrupt(reason = "interrupted"): Promise<void> {
		if (this.#failure) throw this.#failure;
		for (const pending of [...this.#queue]) {
			pending.interruptReason = reason;
			this.#settleRun(pending, failedPythonResult(pending.input.cellId, "Eval interrupted"));
		}
		const active = this.#active;
		const transport = this.#transport;
		if (!active || !transport || active.interruptReason !== undefined) return;
		active.interruptReason = reason;
		if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
		active.timeoutTimer = null;
		active.escalationTimer = setTimeout(
			() => void this.#escalateInterruptedRun(active).catch(() => undefined),
			interruptEscalationMs,
		);
		transport.interrupt(reason);
	}

	async reset(): Promise<void> {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("Python kernel is closed");
		const generation = ++this.#generation;
		const prior = this.#starting;
		const operation = (async () => {
			await prior?.catch(() => undefined);
			if (this.#failure) throw this.#failure;
			if (this.#closed || generation !== this.#generation) throw new Error("Python kernel reset was superseded");
			const transport = this.#transport;
			if (transport) await this.#beginRetirement(transport);
			if (this.#closed || generation !== this.#generation) throw new Error("Python kernel reset was superseded");
			await this.#spawn(generation);
		})();
		this.#starting = operation;
		this.#settleAllPending("Python kernel reset");
		try {
			await operation;
		} finally {
			this.#finishStarting(operation);
		}
	}

	deliverToolReply(): void {}

	async close(): Promise<void> {
		if (this.#closePromise) return await this.#closePromise;
		this.#closed = true;
		this.#generation += 1;
		this.#settleAllPending("Python kernel closed");
		const starting = this.#starting;
		this.#closePromise = (async () => {
			await starting?.catch(() => undefined);
			await this.#retirement?.catch(() => undefined);
			const transport = this.#transport;
			if (!transport) return;
			try {
				await transport.close();
			} catch (error) {
				if (error instanceof Error) throw this.#recordFailure(error);
				throw error;
			}
			if (this.#transport === transport) this.#transport = null;
		})();
		return await this.#closePromise;
	}

	#startNext(): void {
		if (
			this.#closed ||
			this.#failure ||
			this.#active ||
			this.#starting ||
			this.#retirement ||
			this.#queue.length === 0
		)
			return;
		const starting = this.#activateNext();
		this.#starting = starting;
		void starting.then(
			() => this.#finishStarting(starting),
			(error: unknown) => {
				this.#rejectAllPending(error);
				this.#finishStarting(starting);
			},
		);
	}

	async #activateNext(): Promise<void> {
		await this.#ensureStarted();
		if (this.#closed || this.#active || this.#retirement) return;
		const pending = this.#queue.shift();
		if (!pending || !this.#pending.has(pending.input.cellId)) return;
		this.#active = pending;
		pending.startedAt = performance.now();
		const timeoutMs = pending.input.timeoutMs ?? 30_000;
		pending.timeoutTimer = setTimeout(() => this.#timeoutRun(pending, timeoutMs), timeoutMs);
		try {
			this.#transport?.run(pending.input);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.#rejectRun(pending, failure);
		}
	}

	#finishStarting(starting: Promise<void>): void {
		if (this.#starting === starting) this.#starting = null;
		this.#startNext();
	}

	#timeoutRun(pending: PendingRun, timeoutMs: number): void {
		if (this.#active !== pending) return;
		if (this.#transport) void this.#beginRetirement(this.#transport).catch(() => undefined);
		this.#settleRun(
			pending,
			failedPythonResult(pending.input.cellId, `Python kernel timed out after ${timeoutMs}ms`),
		);
	}

	async #ensureStarted(): Promise<void> {
		await this.#retirement;
		if (this.#failure) throw this.#failure;
		if (this.#transport) return;
		await this.#spawn(this.#generation);
	}

	async #spawn(generation: number): Promise<void> {
		if (this.#closed || generation !== this.#generation) throw new Error("Python kernel startup was superseded");
		this.#transport = await PythonKernelTransport.start({
			...this.#options,
			startupTimeoutMs: this.#options.startupTimeoutMs ?? startupTimeoutMs,
			isOwned: () => !this.#closed && generation === this.#generation,
			onRetirementFailure: (transport, error) => {
				if (!this.#transport) this.#transport = transport;
				this.#recordFailure(error);
			},
			onResult: (transport, result) => this.#onResult(transport, result),
			onError: (transport, error) => this.#onError(transport, error),
			onExit: (transport, error) => this.#onExit(transport, error),
		});
	}

	#onResult(transport: PythonKernelTransport, result: ResultMessage): void {
		if (this.#transport !== transport) return;
		const pending = this.#pending.get(result.cellId);
		if (pending) this.#settleRun(pending, result);
	}

	#onExit(transport: PythonKernelTransport, error: Error): void {
		if (this.#transport !== transport) return;
		this.#transport = null;
		const active = this.#active;
		if (active) this.#settleRun(active, failedPythonResult(active.input.cellId, "Python kernel died", error.message));
		this.#startNext();
	}

	#onError(transport: PythonKernelTransport, error: Error): void {
		if (this.#transport !== transport) return;
		const retirement = this.#beginRetirement(transport);
		void retirement.then(
			() => undefined,
			(retirementError: unknown) => {
				this.#recordFailure(
					retirementError instanceof Error ? retirementError : new Error(String(retirementError)),
				);
			},
		);
		const active = this.#active;
		if (active) this.#settleRun(active, failedPythonResult(active.input.cellId, "Python kernel died", error.message));
	}

	#settleRun(pending: PendingRun, result: ResultMessage): void {
		if (!this.#pending.delete(pending.input.cellId)) return;
		this.#removePending(pending);
		const durationMs = pending.startedAt === null ? 0 : Math.max(0, performance.now() - pending.startedAt);
		if (pending.interruptReason !== undefined) {
			const message =
				pending.interruptReason === "Eval interrupted"
					? "Eval interrupted"
					: `Eval interrupted: ${pending.interruptReason}`;
			const error = result.ok ? { message } : { ...result.error, message };
			pending.resolve({ type: "result", cellId: pending.input.cellId, ok: false, error, durationMs });
		} else {
			pending.resolve(result.durationMs === 0 ? { ...result, durationMs } : result);
		}
		this.#startNext();
	}

	#rejectRun(pending: PendingRun, error: unknown): void {
		if (!this.#pending.delete(pending.input.cellId)) return;
		this.#removePending(pending);
		pending.reject(error);
		this.#startNext();
	}

	#removePending(pending: PendingRun): void {
		if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
		if (pending.escalationTimer) clearTimeout(pending.escalationTimer);
		pending.timeoutTimer = null;
		pending.escalationTimer = undefined;
		if (this.#active === pending) this.#active = null;
		const queuedIndex = this.#queue.indexOf(pending);
		if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
	}

	#settleAllPending(message: string): void {
		for (const pending of [...this.#pending.values()])
			this.#settleRun(pending, failedPythonResult(pending.input.cellId, message));
	}

	#rejectAllPending(error: unknown): void {
		for (const pending of [...this.#pending.values()]) this.#rejectRun(pending, error);
	}

	async #escalateInterruptedRun(pending: PendingRun): Promise<void> {
		if (this.#active !== pending || pending.interruptReason === undefined) return;
		const transport = this.#transport;
		if (transport) await this.#beginRetirement(transport);
		if (this.#pending.has(pending.input.cellId))
			this.#settleRun(pending, failedPythonResult(pending.input.cellId, "Eval interrupted"));
	}

	#beginRetirement(transport: PythonKernelTransport): Promise<void> {
		if (this.#retirement) return this.#retirement;
		const operation = (async () => {
			try {
				await transport.retire();
			} catch (error) {
				if (error instanceof Error) throw this.#recordFailure(error);
				throw error;
			}
			if (this.#transport === transport) this.#transport = null;
		})();
		const retirement = operation.finally(() => {
			if (this.#retirement === retirement) this.#retirement = null;
			this.#startNext();
		});
		this.#retirement = retirement;
		return retirement;
	}

	#recordFailure(error: Error): Error {
		this.#failure = error;
		this.#rejectAllPending(error);
		return error;
	}
}
