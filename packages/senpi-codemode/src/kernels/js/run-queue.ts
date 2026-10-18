import type { EvalStatusEvent, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { JavaScriptRunInput } from "./kernel-contract.ts";
import { crashedResult } from "./worker-host.ts";

type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;

export interface PendingJavaScriptRun {
	readonly input: JavaScriptRunInput;
	readonly resolve: (message: ResultMessage) => void;
	readonly reject: (error: Error) => void;
	readonly settlement: Promise<ResultMessage>;
	startedAtMs: number | null;
	settled: boolean;
	/** Host-composed result that wins over whatever the worker reports once an interrupt is in flight. */
	interruptResult: ResultMessage | null;
	interruptAck: PromiseWithResolvers<void> | null;
	settledByWorker: boolean;
	shellWaitActive: boolean;
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
		const { promise, resolve, reject } = Promise.withResolvers<ResultMessage>();
		this.#queue.push({
			input,
			resolve,
			reject,
			settlement: promise,
			startedAtMs: null,
			settled: false,
			interruptResult: null,
			interruptAck: null,
			settledByWorker: false,
			shellWaitActive: false,
		});
		return promise;
	}

	startNext(startedAtMs: number): PendingJavaScriptRun | null {
		if (this.#active) return null;
		const next = this.#queue.shift() ?? null;
		if (next) next.startedAtMs = startedAtMs;
		this.#active = next;
		next?.input.onStarted?.();
		return next;
	}

	acknowledgeInterrupt(event: EvalStatusEvent): void {
		const active = this.#active;
		if (!active || event.cellId !== active.input.cellId) return;
		active.shellWaitActive = event.shellWaitActive === true;
		active.interruptAck?.resolve();
	}

	remove(cellId: string, reason = "interrupted"): boolean {
		const index = this.#queue.findIndex((run) => run.input.cellId === cellId);
		if (index < 0) return false;
		const [run] = this.#queue.splice(index, 1);
		if (!run) return false;
		this.settle(run, stoppedResult(cellId, reason));
		return true;
	}

	snapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		return {
			activeCellId: this.#active?.input.cellId ?? null,
			queuedCellIds: this.#queue.map((run) => run.input.cellId),
		};
	}

	durationMs(run: PendingJavaScriptRun, finishedAtMs: number): number {
		if (run.startedAtMs === null) return 0;
		return Math.max(0, Math.round(finishedAtMs - run.startedAtMs));
	}

	/** Settles `run` as crashed with `error`: the worker died under it. */
	settleCrashed(run: PendingJavaScriptRun, error: Error): void {
		this.releaseActive(run);
		this.settle(run, crashedResult(run.input.cellId, error, this.durationMs(run, performance.now())));
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
		if (active) this.settle(active, active.interruptResult ?? stoppedResult(active.input.cellId, message));
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
