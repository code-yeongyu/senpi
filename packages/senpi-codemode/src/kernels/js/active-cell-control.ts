import type { HostToKernelMessage } from "../../bridge/protocol.ts";
import {
	awaitCooperativeSettlement,
	type JavaScriptInterruptBounds,
	restartedResult,
	restartOutcome,
	type WorkerRetirement,
} from "./interrupt-bounds.ts";
import type { JavaScriptRunQueue, PendingJavaScriptRun } from "./run-queue.ts";

export interface CellStopOutcome {
	readonly retained: boolean;
	readonly note?: string;
}

export interface ActiveCellControlHost {
	readonly runs: JavaScriptRunQueue;
	readonly bounds: JavaScriptInterruptBounds;
	post(message: HostToKernelMessage): void;
	terminate(): Promise<WorkerRetirement>;
	/** Brings a fresh worker up once the stopped one is retired. */
	recover(): void;
	clearToolCalls(): void;
}

/** The running cell's deadline and the protocol that stops it on a timeout or an interrupt. */
export class ActiveCellControl {
	readonly #host: ActiveCellControlHost;
	#timeout: NodeJS.Timeout | null = null;

	constructor(host: ActiveCellControlHost) {
		this.#host = host;
	}

	arm(run: PendingJavaScriptRun): void {
		const timeoutMs = run.input.timeoutMs;
		if (timeoutMs) this.#timeout = setTimeout(() => void this.#timedOut(run, timeoutMs), timeoutMs);
	}

	disarm(): void {
		if (this.#timeout) clearTimeout(this.#timeout);
		this.#timeout = null;
	}

	/**
	 * Asks the worker to settle the active cell cooperatively (rejecting its bridge calls and killing its
	 * children); only a cell that stays unsettled past the grace costs the worker VM. Reports whether the
	 * worker state survived and, when a blocked worker had to be abandoned, the note that explains it.
	 */
	async stop(run: PendingJavaScriptRun, reason: string, message: string, durationMs = 0): Promise<CellStopOutcome> {
		const host = this.#host;
		try {
			run.interruptResult = { type: "result", cellId: run.input.cellId, ok: false, error: { message }, durationMs };
			run.interruptAck ??= Promise.withResolvers<void>();
			host.post({ type: "interrupt", reason });
			if ((await awaitCooperativeSettlement(run, host.bounds)) === "settled") {
				return { retained: run.settledByWorker };
			}
			if (!host.runs.releaseActive(run)) return { retained: run.settledByWorker };
			const retirement = await host.terminate();
			host.runs.settle(run, restartedResult(run, message));
			host.recover();
			return restartOutcome(run, retirement, host.bounds);
		} finally {
			host.clearToolCalls();
		}
	}

	async #timedOut(run: PendingJavaScriptRun, durationMs: number): Promise<void> {
		if (this.#host.runs.active !== run || run.settled) return;
		await this.stop(run, `timed out after ${durationMs}ms`, `JS cell timed out after ${durationMs}ms`, durationMs);
	}
}
