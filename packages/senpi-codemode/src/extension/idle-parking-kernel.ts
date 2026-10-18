import type { HostToKernelMessage } from "../bridge/protocol.ts";
import { kernelToolError } from "../kernels/js/kernel-tools-errors.ts";
import { restartNotice, unstartedResult } from "../kernels/shared/kernel-death.ts";
import type {
	EvalKernel,
	EvalKernelResult,
	EvalKernelRunInput,
	EvalLanguage,
	KernelInterruptHandle,
} from "../tool/types.ts";
import { hasKernelTools, type KernelToolsMethods } from "./kernel-tools-probe.ts";

export type RestartParkedKernel = () => Promise<EvalKernel>;

class IdleParkingKernelClosedError extends Error {
	readonly name = "IdleParkingKernelClosedError";

	constructor() {
		super("Kernel closed");
	}
}

interface WaitingCell {
	readonly cancel: (reason: string) => void;
}

/**
 * Opt-in (`memory.idleParkMinutes` > 0): once no cell has been running or queued on the session's kernel for
 * the configured time, closes it to give its memory back, and starts a fresh one when the next cell arrives.
 * That cell's result says the kernel was restarted and every global is gone. A cell submitted while the
 * kernel is being parked or restarted waits for the fresh kernel; a restart that fails settles that cell
 * with the reason, and the next cell tries again.
 */
export class IdleParkingKernel implements EvalKernel {
	readonly #language: EvalLanguage;
	readonly #idleMs: number;
	readonly #restart: RestartParkedKernel;
	readonly #onParked: () => void;
	#kernel: EvalKernel | null;
	#inFlight = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#parking: Promise<void> | null = null;
	#parkFailure: string | null = null;
	#starting: Promise<EvalKernel> | null = null;
	#announce: string | null = null;
	readonly #waiting = new Map<string, WaitingCell>();
	#closed = false;
	// Present only when the wrapped kernel has kernel tools, so a probe for them sees what it saw before.
	declare readonly describeKernelTools?: KernelToolsMethods["describeKernelTools"];
	declare readonly invokeKernelTool?: KernelToolsMethods["invokeKernelTool"];

	constructor(
		language: EvalLanguage,
		idleMinutes: number,
		first: EvalKernel,
		restart: RestartParkedKernel,
		onParked: () => void = () => {},
	) {
		this.#language = language;
		this.#idleMs = idleMinutes * 60_000;
		this.#restart = restart;
		this.#onParked = onParked;
		this.#kernel = first;
		if (hasKernelTools(first)) {
			const tools: KernelToolsMethods = {
				describeKernelTools: (names) => this.#withTools((kernel) => kernel.describeKernelTools(names)),
				invokeKernelTool: (request, options) =>
					this.#withTools((kernel) => kernel.invokeKernelTool(request, options)),
			};
			Object.assign(this, tools);
		}
		this.#arm();
	}

	run(input: EvalKernelRunInput): Promise<EvalKernelResult> {
		if (this.#closed) return Promise.reject(new IdleParkingKernelClosedError());
		this.#disarm();
		this.#inFlight++;
		return this.#runOnCurrent(input).finally(() => {
			this.#inFlight--;
			this.#arm();
		});
	}

	cancelQueued(cellId: string, reason: string): boolean {
		if (this.#cancelWaiting(cellId, reason)) return true;
		return this.#kernel?.cancelQueued(cellId, reason) ?? false;
	}

	async interrupt(reason = "interrupted", cellId?: string): Promise<KernelInterruptHandle> {
		if (cellId !== undefined && this.#cancelWaiting(cellId, reason)) return { stateRetained: Promise.resolve(true) };
		if (cellId === undefined) for (const id of [...this.#waiting.keys()]) this.#cancelWaiting(id, reason);
		const kernel = this.#kernel;
		if (kernel === null) return { stateRetained: Promise.resolve(true) };
		return await kernel.interrupt(reason, cellId);
	}

	queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		const current = this.#kernel?.queueSnapshot() ?? { activeCellId: null, queuedCellIds: [] };
		return { activeCellId: current.activeCellId, queuedCellIds: [...current.queuedCellIds, ...this.#waiting.keys()] };
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		this.#kernel?.deliverToolReply(message);
	}

	async reset(): Promise<void> {
		this.#announce = null;
		const kernel = this.#kernel;
		if (kernel !== null) await kernel.reset();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#disarm();
		for (const id of [...this.#waiting.keys()]) this.#cancelWaiting(id, new IdleParkingKernelClosedError().message);
		if (this.#parking !== null) await this.#parking;
		if (this.#starting !== null) await this.#starting.catch(() => undefined);
		const kernel = this.#kernel;
		this.#kernel = null;
		if (kernel !== null) await kernel.close();
	}

	listKernelToolNames(): readonly string[] {
		return this.#kernel?.listKernelToolNames?.() ?? [];
	}

	/** A tool call is work on the kernel: it keeps the kernel from being parked under it. */
	async #withTools<T>(use: (kernel: KernelToolsMethods) => Promise<T>): Promise<T> {
		const kernel = this.#parking === null ? this.#kernel : null;
		if (this.#closed || kernel === null || !hasKernelTools(kernel)) {
			throw kernelToolError(
				"tools_unavailable",
				`the ${this.#language} kernel was parked after idling, so the tools it defined are gone; run a cell to start a fresh kernel`,
			);
		}
		this.#disarm();
		this.#inFlight++;
		try {
			return await use(kernel);
		} finally {
			this.#inFlight--;
			this.#arm();
		}
	}

	#runOnCurrent(input: EvalKernelRunInput): Promise<EvalKernelResult> {
		const kernel = this.#kernel;
		if (kernel !== null && this.#parking === null) return kernel.run(input).then((result) => this.#announced(result));
		return new Promise((settle, reject) => {
			let cancelled = false;
			this.#waiting.set(input.cellId, {
				cancel: (reason) => {
					cancelled = true;
					settle(unstartedResult(input.cellId, reason));
				},
			});
			this.#current().then(
				(current) => {
					this.#waiting.delete(input.cellId);
					if (cancelled) return;
					current.run(input).then((result) => settle(this.#announced(result)), reject);
				},
				(error: unknown) => {
					this.#waiting.delete(input.cellId);
					if (!cancelled) settle(unstartedResult(input.cellId, this.#restartFailure(error)));
				},
			);
		});
	}

	async #current(): Promise<EvalKernel> {
		if (this.#parking !== null) await this.#parking;
		const failure = this.#parkFailure;
		if (failure !== null) {
			this.#parkFailure = null;
			throw new Error(failure);
		}
		if (this.#kernel !== null) return this.#kernel;
		if (this.#closed) throw new IdleParkingKernelClosedError();
		this.#starting ??= this.#restart()
			.then((kernel) => {
				this.#kernel = kernel;
				this.#announce = restartNotice(this.#language, this.#parkReason());
				return kernel;
			})
			.finally(() => {
				this.#starting = null;
			});
		return await this.#starting;
	}

	#announced(result: EvalKernelResult): EvalKernelResult {
		const notice = this.#announce;
		if (notice === null) return result;
		this.#announce = null;
		return {
			...result,
			notice: result.notice === undefined ? notice : `${notice}\n${result.notice}`,
			kernelState: "restarted",
		};
	}

	#arm(): void {
		if (this.#closed || this.#inFlight > 0 || this.#kernel === null || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#park();
		}, this.#idleMs);
		this.#timer.unref?.();
	}

	#disarm(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#park(): void {
		const kernel = this.#kernel;
		if (this.#closed || this.#inFlight > 0 || kernel === null) return;
		const snapshot = kernel.queueSnapshot();
		// Tools a cell defined stay callable by child tasks between cells, so their kernel is never parked.
		const hasTools = (kernel.listKernelToolNames?.() ?? []).length > 0;
		if (snapshot.activeCellId !== null || snapshot.queuedCellIds.length > 0 || hasTools) {
			this.#arm();
			return;
		}
		this.#kernel = null;
		this.#onParked();
		const parking = kernel
			.close()
			.catch((error: unknown) => {
				this.#parkFailure = `the idle ${this.#language} kernel could not be stopped: ${errorText(error)}; run the cell again to start a fresh kernel`;
			})
			.finally(() => {
				if (this.#parking === parking) this.#parking = null;
			});
		this.#parking = parking;
	}

	#cancelWaiting(cellId: string, reason: string): boolean {
		const waiting = this.#waiting.get(cellId);
		if (waiting === undefined) return false;
		this.#waiting.delete(cellId);
		waiting.cancel(reason);
		return true;
	}

	#parkReason(): string {
		const minutes = this.#idleMs / 60_000;
		return `idling for ${minutes} minute${minutes === 1 ? "" : "s"} (memory.idleParkMinutes)`;
	}

	#restartFailure(error: unknown): string {
		return `the ${this.#language} kernel parked after idling did not restart: ${errorText(error)}; run the cell again to retry`;
	}
}

export function parkWhenIdle(
	language: EvalLanguage,
	idleMinutes: number,
	kernel: EvalKernel,
	restart: RestartParkedKernel,
	onParked?: () => void,
): EvalKernel {
	return idleMinutes > 0 ? new IdleParkingKernel(language, idleMinutes, kernel, restart, onParked) : kernel;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
