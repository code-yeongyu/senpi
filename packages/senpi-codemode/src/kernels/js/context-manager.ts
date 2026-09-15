import type { EvalStatusEvent, HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { CHILD_LIFECYCLE_OP, INTERRUPT_ACK_OP } from "../../bridge/reserved.ts";
import type { KernelInterruptHandle } from "../../tool/types.ts";
import { abandonedWorkerNote, awaitCooperativeSettlement, type WorkerRetirement } from "./interrupt-bounds.ts";
import {
	assertJavaScriptKernelOpen,
	type JavaScriptKernelMode,
	type JavaScriptRunInput,
	type LifecycleState,
	type ResultMessage,
	type ToolCallMessage,
} from "./kernel-contract.ts";
import { type JavaScriptKernelOptions, LocalModuleLoader } from "./local-module-loader.ts";
import { terminateProcessTrees } from "./process-tree-host.ts";
import { JavaScriptRunQueue, type PendingJavaScriptRun, stoppedResult } from "./run-queue.ts";
import { bridgeError, WorkerStartupCancelledError } from "./worker-host.ts";
import { WorkerSlot } from "./worker-slot.ts";

export { JavaScriptKernelClosedError, type JavaScriptKernelMode, type JavaScriptRunInput } from "./kernel-contract.ts";
export type { JavaScriptKernelOptions } from "./local-module-loader.ts";
export { type JavaScriptWorkerEntryUrlOptions, resolveJsWorkerEntryUrl } from "./worker-startup.ts";

/** How long a lost worker's children get to honour SIGTERM before the host sends SIGKILL. */
const WORKER_LOSS_CHILD_GRACE_MS = 1_000;

export class JavaScriptKernel {
	readonly #options: JavaScriptKernelOptions;
	readonly #moduleLoader: LocalModuleLoader;
	readonly #slot: WorkerSlot;
	#lifecycle: LifecycleState = "open";
	#activation: Promise<void> | null = null;
	#recovery: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	readonly #runs = new JavaScriptRunQueue();
	#timeout: NodeJS.Timeout | null = null;
	#toolWaiters: Array<(message: ToolCallMessage) => void> = [];
	#pendingToolCalls: ToolCallMessage[] = [];
	/** Live cell children the worker reported; retired by the host when the worker itself is lost. */
	readonly #childPids = new Set<number>();

	constructor(options: JavaScriptKernelOptions) {
		this.#options = options;
		this.#moduleLoader = new LocalModuleLoader(options);
		this.#slot = new WorkerSlot(options, {
			isOpen: () => this.#lifecycle === "open",
			onMessage: (message) => this.#handleMessage(message),
			onCrash: (error) => this.#handleCrash(error),
		});
	}

	get mode(): JavaScriptKernelMode {
		return this.#slot.mode;
	}

	async run(input: JavaScriptRunInput): Promise<ResultMessage> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		const promise = this.#runs.enqueue(input);
		this.#activate();
		return await promise;
	}

	async interrupt(reason = "interrupted"): Promise<KernelInterruptHandle> {
		assertJavaScriptKernelOpen(this.#lifecycle, "interrupt");
		const active = this.#runs.active;
		if (!active) {
			const queued = this.#runs.takeInterruptTarget();
			if (!queued) return { stateRetained: Promise.resolve(true) };
			this.#runs.settle(queued, stoppedResult(queued.input.cellId, `JS cell interrupted: ${reason}`));
			await this.#restartAfterStop();
			return { stateRetained: Promise.resolve(false) };
		}
		this.#clearTimeout();
		const stop = await this.#stopActive(active, reason, `JS cell interrupted: ${reason}`);
		return { stateRetained: Promise.resolve(stop.retained), ...(stop.note === undefined ? {} : { note: stop.note }) };
	}

	async reset(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#terminate();
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#ensureReady();
		this.#startNext();
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		if (this.#lifecycle === "open") this.#slot.postMessage(message);
	}

	async nextToolCall(): Promise<ToolCallMessage> {
		const pending = this.#pendingToolCalls.shift();
		if (pending) return pending;
		return await new Promise((resolve) => this.#toolWaiters.push(resolve));
	}

	async close(): Promise<void> {
		if (this.#closePromise) return await this.#closePromise;
		this.#slot.postMessage({ type: "close" });
		this.#lifecycle = "closing";
		this.#runs.settleAll("JS kernel closed");
		const recovery = this.#recovery;
		const closePromise = (async () => {
			if (recovery) await recovery;
			await this.#terminate();
		})().finally(() => {
			this.#lifecycle = "closed";
		});
		this.#closePromise = closePromise;
		return await closePromise;
	}

	#activate(): void {
		if (this.#activation || this.#lifecycle !== "open" || this.#runs.active || !this.#runs.hasWaiting) return;
		const activation = this.#activateWhenReady();
		this.#activation = activation;
		void activation.then(() => {
			if (this.#activation === activation) this.#activation = null;
			if (this.#lifecycle === "open" && !this.#runs.active && this.#runs.hasWaiting) this.#activate();
		});
	}

	async #activateWhenReady(): Promise<void> {
		try {
			await this.#ensureReady();
			if (this.#lifecycle === "open") this.#startNext();
		} catch (error) {
			if (error instanceof WorkerStartupCancelledError) return;
			this.#runs.rejectWaiting(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async #ensureReady(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		await this.#slot.ensureReady();
	}

	#startNext(): void {
		if (this.#lifecycle !== "open" || this.#runs.active || !this.#slot.present) return;
		const next = this.#runs.startNext(performance.now());
		if (!next) return;
		if (next.input.timeoutMs) {
			this.#timeout = setTimeout(() => void this.#timeoutActive(next), next.input.timeoutMs);
		}
		this.#slot.postMessage({
			type: "run",
			cellId: next.input.cellId,
			code: this.#moduleLoader.prepareCell(next.input.code),
			timeoutMs: next.input.timeoutMs,
		});
	}

	async #timeoutActive(run: PendingJavaScriptRun): Promise<void> {
		if (this.#runs.active !== run || run.settled) return;
		const durationMs = run.input.timeoutMs ?? 0;
		await this.#stopActive(
			run,
			`timed out after ${durationMs}ms`,
			`JS cell timed out after ${durationMs}ms`,
			durationMs,
		);
	}

	/**
	 * Asks the worker to settle the active cell cooperatively (rejecting its bridge calls and killing its
	 * children); only a cell that stays unsettled past the grace costs the worker VM. Reports whether the
	 * worker state survived and, when a blocked worker had to be abandoned, the note that explains it.
	 */
	async #stopActive(
		run: PendingJavaScriptRun,
		reason: string,
		message: string,
		durationMs = 0,
	): Promise<{ readonly retained: boolean; readonly note?: string }> {
		run.interruptResult = { type: "result", cellId: run.input.cellId, ok: false, error: { message }, durationMs };
		run.interruptAck ??= Promise.withResolvers<void>();
		this.#slot.postMessage({ type: "interrupt", reason });
		if ((await awaitCooperativeSettlement(run)) === "settled") return { retained: run.settledByWorker };
		if (!this.#runs.releaseActive(run)) return { retained: run.settledByWorker };
		const retirement = await this.#terminate();
		this.#runs.settle(run, run.interruptResult ?? stoppedResult(run.input.cellId, message));
		void this.#recover(() => Promise.resolve());
		return retirement === "abandoned" ? { retained: false, note: abandonedWorkerNote() } : { retained: false };
	}

	async #restartAfterStop(): Promise<void> {
		await this.#recover(() => this.#terminate());
	}

	/** One recovery at a time: retire through `retire` (a no-op when the worker is already gone), then bring a fresh worker up. */
	async #recover(retire: () => Promise<unknown>): Promise<void> {
		if (this.#recovery) return await this.#recovery;
		const recovery = this.#performRecovery(retire);
		this.#recovery = recovery;
		try {
			await recovery;
		} finally {
			if (this.#recovery === recovery) this.#recovery = null;
		}
	}

	async #performRecovery(retire: () => Promise<unknown>): Promise<void> {
		try {
			await retire();
			if (this.#lifecycle !== "open") return;
			await this.#ensureReady();
			if (this.#lifecycle === "open") this.#startNext();
		} catch (error) {
			if (error instanceof WorkerStartupCancelledError) return;
			this.#runs.rejectWaiting(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#handleMessage(message: KernelToHostMessage): void {
		if (message.type === "status" && message.event.op === INTERRUPT_ACK_OP) {
			this.#runs.active?.interruptAck?.resolve();
			return;
		}
		if (message.type === "status" && message.event.op === CHILD_LIFECYCLE_OP) {
			this.#trackChildEvent(message.event);
			return;
		}
		this.#options.onMessage?.(message);
		this.#runs.active?.input.onMessage?.(message);
		if (message.type === "tool-call") {
			const waiter = this.#toolWaiters.shift();
			if (waiter) waiter(message);
			else this.#pendingToolCalls.push(message);
			return;
		}
		if (message.type !== "result") return;
		const active = this.#runs.active;
		if (!active || active.input.cellId !== message.cellId) return;
		this.#clearTimeout();
		this.#runs.releaseActive(active);
		active.settledByWorker = true;
		this.#runs.settle(active, active.interruptResult ?? message);
		this.#startNext();
	}

	#handleCrash(error: Error): void {
		const active = this.#runs.active;
		if (!active && this.#slot.startingUp) return;
		this.#clearTimeout();
		if (active) {
			this.#runs.releaseActive(active);
			this.#runs.settle(active, {
				type: "result",
				cellId: active.input.cellId,
				ok: false,
				error: bridgeError(error),
				durationMs: this.#runs.durationMs(active, performance.now()),
			});
		}
		void this.#restartAfterStop();
	}

	#clearTimeout(): void {
		if (this.#timeout) clearTimeout(this.#timeout);
		this.#timeout = null;
	}

	#trackChildEvent(event: EvalStatusEvent): void {
		const pid = event.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
		if (event.state === "spawned") this.#childPids.add(pid);
		else if (event.state === "exited") this.#childPids.delete(pid);
	}

	/**
	 * Retire the worker, then whatever cell children it still owned: a terminated or crashed worker never
	 * reaches its own cell-end cleanup, and a pid `ps` no longer lists as our child was reused and is skipped.
	 */
	async #terminate(): Promise<WorkerRetirement> {
		this.#clearTimeout();
		const retirement = await this.#slot.retire();
		await this.#retireWorkerChildren();
		return retirement;
	}

	async #retireWorkerChildren(): Promise<void> {
		if (this.#childPids.size === 0) return;
		const pids = [...this.#childPids];
		this.#childPids.clear();
		await terminateProcessTrees(pids, { graceMs: WORKER_LOSS_CHILD_GRACE_MS, ownerPid: process.pid });
	}
}
