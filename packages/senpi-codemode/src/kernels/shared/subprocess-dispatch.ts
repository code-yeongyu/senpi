import { encodeBridgeFrame } from "../../bridge/protocol.ts";
import type { KernelInterruptHandle } from "../../tool/types.ts";
import type { SubprocessProcess } from "./subprocess-process.ts";
import type { SubprocessRunQueue } from "./subprocess-queue.ts";
import {
	CellInterruptedError,
	failureResult,
	KernelProcessError,
	type PendingRun,
	timeoutResult,
} from "./subprocess-run.ts";

export interface SubprocessDispatchHost {
	readonly runs: SubprocessRunQueue;
	/** The live process when a run may be sent to it now (open, started, not retiring), otherwise null. */
	readyProcess(): SubprocessProcess | null;
	currentProcess(): SubprocessProcess | null;
	restartProcess(process: SubprocessProcess | null, signal?: NodeJS.Signals, escalationMs?: number): Promise<void>;
	failClosed(error: Error): void;
	failure(): Error | null;
}

export class SubprocessRunDispatch {
	readonly #host: SubprocessDispatchHost;

	constructor(host: SubprocessDispatchHost) {
		this.#host = host;
	}

	pump(): void {
		const runs = this.#host.runs;
		const process = this.#host.readyProcess();
		if (runs.active || !process) return;
		const run = runs.startNext(performance.now());
		if (!run) return;
		const timeoutMs = run.input.timeoutMs;
		if (timeoutMs !== undefined) run.timer = setTimeout(() => this.#timedOut(run, timeoutMs), timeoutMs);
		try {
			process.send(encodeBridgeFrame({ type: "run", cellId: run.input.cellId, code: run.input.code, timeoutMs }));
		} catch (error) {
			this.#host.failClosed(new KernelProcessError(error instanceof Error ? error.message : String(error)));
		}
	}

	async interruptActive(reason: string): Promise<KernelInterruptHandle> {
		const runs = this.#host.runs;
		const process = this.#host.currentProcess();
		process?.retire();
		runs.clearToolCalls();
		const run = runs.active;
		if (!run) return { stateRetained: Promise.resolve(true) };
		runs.releaseActive(run);
		runs.settle(run, failureResult(run, new CellInterruptedError(reason)));
		const signal = globalThis.process.platform === "win32" ? "SIGTERM" : "SIGINT";
		await this.#host.restartProcess(process, signal, 5_000);
		const failure = this.#host.failure();
		if (failure) throw failure;
		// Restart always spawns a fresh interpreter, so no user global survives.
		return { stateRetained: Promise.resolve(false) };
	}

	#timedOut(run: PendingRun, timeoutMs: number): void {
		const runs = this.#host.runs;
		if (runs.active !== run || run.settled) return;
		const process = this.#host.currentProcess();
		process?.retire();
		runs.clearToolCalls();
		runs.releaseActive(run);
		runs.settle(run, timeoutResult(run, timeoutMs));
		void this.#host.restartProcess(process);
	}
}
