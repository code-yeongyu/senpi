// allow: SIZE_OK — one persistent Python lifecycle state machine owns queue, generation, and retirement.
import type { KernelInterruptHandle, PendingCell } from "../../tool/types.ts";
import type { KernelToolsInvokeOptions } from "../js/kernel-tools-types.ts";
import { rejectKernelToolsUnavailable } from "../kernel-tools-unavailable.ts";
import { describeExit } from "../shared/kernel-death.ts";
import { KernelMemoryHost } from "../shared/kernel-memory-host.ts";
import { KernelPreludeTracker } from "../shared/kernel-prelude-plan.ts";
import { runHostCell } from "./host-cell.ts";
import type { PendingRun, PythonKernelRunOptions, PythonKernelStartOptions, ResultMessage } from "./kernel-contract.ts";
import { pythonStartupHangGuardMs } from "./startup.ts";
import { failedPythonResult, PythonKernelTransport } from "./transport.ts";

export type { PythonKernelRunOptions, PythonKernelStartOptions } from "./kernel-contract.ts";
export type { KernelChild, KernelSpawnOptions, KernelSpawnProcess } from "./process.ts";

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
	readonly #preludes = new KernelPreludeTracker();
	readonly #memory: KernelMemoryHost | null;
	#generation = 0;
	#closed = false;
	#dead = false;

	private constructor(options: PythonKernelStartOptions) {
		this.#options = options;
		this.#memory = options.memory === undefined ? null : new KernelMemoryHost("py", options.memory);
	}

	static async start(options: PythonKernelStartOptions): Promise<PythonKernel> {
		const kernel = new PythonKernel(options);
		await kernel.#spawn(kernel.#generation);
		return kernel;
	}

	listKernelToolNames(): readonly string[] {
		return [];
	}

	isAlive(): boolean {
		return !this.#dead;
	}

	drainPending(): readonly PendingCell[] {
		return [...this.#queue].map((pending) => {
			this.#pending.delete(pending.input.cellId);
			this.#removePending(pending);
			return { input: pending.input, settle: pending.resolve };
		});
	}

	describeKernelTools(_names: readonly string[]): Promise<never> {
		return rejectKernelToolsUnavailable();
	}

	invokeKernelTool(_request: unknown, _options?: AbortSignal | KernelToolsInvokeOptions): Promise<never> {
		return rejectKernelToolsUnavailable();
	}

	run(input: PythonKernelRunOptions): Promise<ResultMessage> {
		if (this.#failure) return Promise.reject(this.#failure);
		if (this.#closed) return Promise.reject(new Error("Python kernel is closed"));
		if (this.#dead) return Promise.reject(new Error("Python kernel died"));
		return new Promise<ResultMessage>((resolve, reject) => {
			const pending: PendingRun = { input, resolve, reject, startedAt: null, timeoutTimer: null };
			this.#pending.set(input.cellId, pending);
			this.#queue.push(pending);
			this.#startNext();
		});
	}

	cancelQueued(cellId: string, reason: string): boolean {
		const pending = this.#queue.find((run) => run.input.cellId === cellId);
		if (!pending) return false;
		this.#settleRun(pending, failedPythonResult(cellId, reason));
		return true;
	}

	queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		return {
			activeCellId: this.#active?.input.cellId ?? null,
			queuedCellIds: this.#queue.map((run) => run.input.cellId),
		};
	}

	async interrupt(reason = "interrupted", cellId?: string): Promise<KernelInterruptHandle> {
		if (this.#failure) throw this.#failure;
		if (cellId !== undefined && this.#active?.input.cellId !== cellId) {
			const cancelled = this.cancelQueued(cellId, reason);
			return { stateRetained: Promise.resolve(true), ...(cancelled ? {} : { note: "cell not found" }) };
		}
		if (cellId === undefined) {
			for (const pending of [...this.#queue]) {
				pending.interruptReason = reason;
				this.#settleRun(pending, failedPythonResult(pending.input.cellId, "Eval interrupted"));
			}
		}
		const active = this.#active;
		if (active?.hostAbort && active.interruptReason === undefined) {
			active.interruptReason = reason;
			this.#settleRun(active, failedPythonResult(active.input.cellId, "Eval interrupted"));
			return { stateRetained: Promise.resolve(true) };
		}
		const transport = this.#transport;
		if (!active || !transport || active.interruptReason !== undefined)
			return { stateRetained: Promise.resolve(true) };
		active.interruptReason = reason;
		if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
		active.timeoutTimer = null;
		active.escalationTimer = setTimeout(
			() => void this.#escalateInterruptedRun(active).catch(() => undefined),
			interruptEscalationMs,
		);
		const stateRetained = new Promise<boolean>((resolve) => {
			active.resolveStateRetained = resolve;
		});
		transport.interrupt(reason);
		return { stateRetained };
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
			this.#dead ||
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
		pending.input.onStarted?.();
		const timeoutMs = pending.input.timeoutMs;
		if (timeoutMs !== undefined)
			pending.timeoutTimer = setTimeout(() => this.#timeoutRun(pending, timeoutMs), timeoutMs);
		const host = pending.input.host;
		if (host !== undefined) {
			runHostCell(pending, host, {
				emit: (message) => (pending.input.onMessage ?? this.#options.onMessage)?.(message),
				settle: (result) => this.#settleRun(pending, result),
			});
			return;
		}
		try {
			this.#transport?.run({
				...pending.input,
				preludePlan: this.#preludes.plan(pending.input.kernelPreludes ?? []),
			});
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
		if (this.#transport && !pending.hostAbort) void this.#beginRetirement(this.#transport).catch(() => undefined);
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
		this.#memory?.processReplaced();
		this.#transport = await PythonKernelTransport.start({
			...this.#options,
			onMessage: (message) => {
				if (message.type === "result") return;
				const callback =
					message.type === "ready" || message.type === "init-failed" || message.type === "closed"
						? this.#options.onMessage
						: (this.#active?.input.onMessage ?? this.#options.onMessage);
				callback?.(message);
			},
			startupTimeoutMs: this.#options.startupTimeoutMs ?? pythonStartupHangGuardMs,
			isOwned: () => !this.#closed && generation === this.#generation,
			onRetirementFailure: (transport, error) => {
				if (!this.#transport) this.#transport = transport;
				this.#recoverWhenGone(transport, this.#recordFailure(error));
			},
			onResult: (transport, result) => this.#onResult(transport, result),
			onError: (transport, error) => this.#onError(transport, error),
			onExit: (transport, error, exit) => this.#onExit(transport, error, describeExit(exit.code, exit.signal)),
		});
	}

	#onResult(transport: PythonKernelTransport, result: ResultMessage): void {
		if (this.#transport !== transport) return;
		const pending = this.#pending.get(result.cellId);
		if (pending) {
			const annotated = this.#memory?.annotate(result) ?? result;
			(pending.input.onMessage ?? this.#options.onMessage)?.(annotated);
			this.#settleRun(pending, annotated);
		}
		// A result frame from the live runner proves the process survived the interrupt.
		if (pending?.resolveStateRetained) pending.resolveStateRetained(true);
		this.#recycleOverCeilingWhenIdle();
	}

	/** An over-ceiling kernel restarts only once no cell is running or queued on it. */
	#recycleOverCeilingWhenIdle(): void {
		if (!this.#memory?.claimRecycle(this.#active === null && this.#queue.length === 0)) return;
		// A failed restart is recorded in #failure and rejects the next run; a superseded one lost to close/reset.
		void this.reset().catch(() => undefined);
	}

	#onExit(transport: PythonKernelTransport, error: Error, reason: string): void {
		if (this.#transport !== transport) return;
		this.#transport = null;
		// With an owner listening, a death is final for this instance: the cells that never started stay
		// queued for `drainPending` and the owner replaces it. Without one it respawns lazily, as before.
		const onDeath = this.#options.onDeath;
		if (onDeath) this.#dead = true;
		const active = this.#active;
		if (active) {
			if (active.resolveStateRetained) active.resolveStateRetained(false);
			const message = onDeath ? "Python kernel died; every global is lost" : "Python kernel died";
			this.#settleRun(active, failedPythonResult(active.input.cellId, message, error.message));
		}
		if (onDeath) onDeath(reason);
		else this.#startNext();
	}

	/**
	 * A retirement that timed out is reported, and no second interpreter starts while the first may live.
	 * Once that process is seen to exit after all, the failure is over: this instance is dead, not broken.
	 */
	#recoverWhenGone(transport: PythonKernelTransport, failure: Error): void {
		const onDeath = this.#options.onDeath;
		if (!onDeath) return;
		void transport.whenGone().then(() => {
			if (this.#closed || this.#failure !== failure) return;
			this.#failure = null;
			this.#dead = true;
			if (this.#transport === transport) this.#transport = null;
			onDeath("an interpreter that outlived its SIGKILL grace");
		});
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
		if (active) {
			if (active.resolveStateRetained) active.resolveStateRetained(false);
			this.#settleRun(active, failedPythonResult(active.input.cellId, "Python kernel died", error.message));
		}
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
		pending.hostAbort?.abort();
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
		if (pending.resolveStateRetained) pending.resolveStateRetained(false);
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
				if (!(error instanceof Error)) throw error;
				const failure = this.#recordFailure(error);
				this.#recoverWhenGone(transport, failure);
				throw failure;
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
