import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { JavaScriptRunInput } from "./kernel-contract.ts";

type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;

export interface PendingJavaScriptRun {
	readonly input: JavaScriptRunInput;
	readonly resolve: (message: ResultMessage) => void;
	readonly reject: (error: Error) => void;
	startedAtMs: number | null;
	settled: boolean;
}

export class JavaScriptRunQueue {
	#queue: PendingJavaScriptRun[] = [];
	#active: PendingJavaScriptRun | null = null;

	get active(): PendingJavaScriptRun | null {
		return this.#active;
	}

	get hasWaiting(): boolean {
		return this.#queue.length > 0;
	}

	enqueue(input: JavaScriptRunInput): Promise<ResultMessage> {
		return new Promise((resolve, reject) => {
			this.#queue.push({ input, resolve, reject, startedAtMs: null, settled: false });
		});
	}

	startNext(startedAtMs: number): PendingJavaScriptRun | null {
		if (this.#active) return null;
		const next = this.#queue.shift() ?? null;
		if (next) next.startedAtMs = startedAtMs;
		this.#active = next;
		return next;
	}

	durationMs(run: PendingJavaScriptRun, finishedAtMs: number): number {
		if (run.startedAtMs === null) return 0;
		return Math.max(0, Math.round(finishedAtMs - run.startedAtMs));
	}

	takeInterruptTarget(): PendingJavaScriptRun | null {
		if (!this.#active) return this.#queue.shift() ?? null;
		const active = this.#active;
		this.#active = null;
		return active;
	}

	releaseActive(run: PendingJavaScriptRun): boolean {
		if (this.#active !== run) return false;
		this.#active = null;
		return true;
	}

	settle(run: PendingJavaScriptRun, result: ResultMessage): void {
		if (run.settled) return;
		run.settled = true;
		run.resolve(result);
	}

	settleAll(message: string): void {
		const active = this.#active;
		this.#active = null;
		if (active) this.settle(active, stoppedResult(active.input.cellId, message));
		for (const queued of this.#queue.splice(0)) this.settle(queued, stoppedResult(queued.input.cellId, message));
	}

	rejectWaiting(error: Error): void {
		for (const queued of this.#queue.splice(0)) {
			if (queued.settled) continue;
			queued.settled = true;
			queued.reject(error);
		}
	}
}

export function stoppedResult(cellId: string, message: string): ResultMessage {
	return { type: "result", cellId, ok: false, error: { message }, durationMs: 0 };
}
