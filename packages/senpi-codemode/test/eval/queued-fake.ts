import type { KernelToHostMessage } from "../../src/bridge/protocol.ts";
import type { EvalKernelRunInput, KernelInterruptHandle } from "../../src/tool/types.ts";
import { Deferred, FakeKernel, result } from "./fakes.ts";

type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
type Run = { input: EvalKernelRunInput; done: Deferred<KernelResult> };

/** Event-gated FIFO double preserving per-run callbacks, dequeue and targeted interrupt. */
export class QueuedFakeKernel extends FakeKernel {
	private active: Run | undefined;
	private nextStart: Deferred<void> | undefined;
	private readonly queue: Run[] = [];
	private readonly admissions = new Map<string, Deferred<void>>();
	private readonly starts = new Map<string, Deferred<void>>();

	constructor() {
		super([]);
	}

	override deferNextRun(): Promise<void> {
		this.nextStart = new Deferred<void>();
		return this.nextStart.promise;
	}

	admitted(cellId: string): Promise<void> {
		const event = new Deferred<void>();
		this.admissions.set(cellId, event);
		return event.promise;
	}

	started(cellId: string): Promise<void> {
		const event = new Deferred<void>();
		this.starts.set(cellId, event);
		return event.promise;
	}

	override async run(input: EvalKernelRunInput): Promise<KernelResult> {
		this.runs.push(input);
		const run = { input, done: new Deferred<KernelResult>() };
		this.queue.push(run);
		this.startNext();
		this.admissions.get(input.cellId)?.resolve(undefined);
		return await run.done.promise;
	}

	private startNext(): void {
		if (this.active) return;
		this.active = this.queue.shift();
		this.active?.input.onStarted?.();
		if (this.active) {
			this.nextStart?.resolve(undefined);
			this.nextStart = undefined;
		}
		if (this.active) this.starts.get(this.active.input.cellId)?.resolve(undefined);
	}

	override emit(message: KernelToHostMessage): void {
		(this.active?.input.onMessage ?? this.onMessage)?.(message);
	}

	override completeDeferredRun(next: KernelResult): void {
		if (!this.active || next.cellId !== this.active.input.cellId) throw new Error("No matching active run");
		this.active.done.resolve(next);
		this.active = undefined;
		this.startNext();
	}

	override cancelQueued(cellId: string, reason: string): boolean {
		const index = this.queue.findIndex((run) => run.input.cellId === cellId);
		if (index < 0) return false;
		const [run] = this.queue.splice(index, 1);
		run?.done.resolve({ ...result(cellId, ""), ok: false, error: { message: reason } });
		return true;
	}

	override async interrupt(reason?: string, cellId?: string): Promise<KernelInterruptHandle> {
		this.interrupts.push(reason);
		if (cellId && this.cancelQueued(cellId, reason ?? "cancelled")) return { stateRetained: Promise.resolve(true) };
		if (this.active && (!cellId || this.active.input.cellId === cellId)) {
			this.completeDeferredRun({
				...result(this.active.input.cellId, ""),
				ok: false,
				error: { message: reason ?? "cancelled" },
			});
		}
		return { stateRetained: Promise.resolve(true) };
	}

	override queueSnapshot() {
		return {
			activeCellId: this.active?.input.cellId ?? null,
			queuedCellIds: this.queue.map((run) => run.input.cellId),
		};
	}
}
