import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { KernelInterruptHandle } from "../../tool/types.ts";
import { KernelToolHostPump } from "../shared/kernel-tools-pump.ts";
import { ActiveCellControl } from "./active-cell-control.ts";
import { dispatchCell } from "./cell-dispatch.ts";
import { consumeControlFrame } from "./control-frames.ts";
import { HostEntries } from "./host-entries.ts";
import { DEFAULT_INTERRUPT_BOUNDS, JS_INTERRUPT_GRACE_MS, type WorkerRetirement } from "./interrupt-bounds.ts";
import {
	assertJavaScriptKernelOpen,
	type JavaScriptKernelMode,
	type JavaScriptRunInput,
	type LifecycleState,
	type ResultMessage,
	type ToolCallMessage,
} from "./kernel-contract.ts";
import { JavaScriptKernelMemory } from "./kernel-memory.ts";
import type { JavaScriptMemoryReading } from "./kernel-memory-bridge.ts";
import { kernelToolError } from "./kernel-tools-errors.ts";
import type {
	KernelToolsDescribeResult,
	KernelToolsInvokeOptions,
	KernelToolsInvokeRequest,
} from "./kernel-tools-types.ts";
import { type JavaScriptKernelOptions, LocalModuleLoader } from "./local-module-loader.ts";
import { JavaScriptRunQueue, type PendingJavaScriptRun } from "./run-queue.ts";
import { ToolCallQueue } from "./tool-call-queue.ts";
import { WorkerChildren } from "./worker-children.ts";
import { WorkerRecovery } from "./worker-recovery.ts";
import { WorkerSlot } from "./worker-slot.ts";

export { JavaScriptKernelClosedError, type JavaScriptKernelMode, type JavaScriptRunInput } from "./kernel-contract.ts";
export type { JavaScriptMemoryReading } from "./kernel-memory-bridge.ts";
export type { JavaScriptKernelOptions } from "./local-module-loader.ts";
export { type JavaScriptWorkerEntryUrlOptions, resolveJsWorkerEntryUrl } from "./worker-startup.ts";

export class JavaScriptKernel {
	readonly #hostEntries = new HostEntries<PendingJavaScriptRun>({
		emit: (run, message) => (run.input.onMessage ?? this.#options.onMessage)?.(message),
		settle: (run, result) => {
			if (!this.#runs.releaseActive(run)) return;
			this.#runs.settle(run, result);
			this.#startNext();
		},
		durationMs: (run) => this.#runs.durationMs(run, performance.now()),
	});
	readonly #options: JavaScriptKernelOptions;
	readonly #moduleLoader: LocalModuleLoader;
	readonly #slot: WorkerSlot;
	#lifecycle: LifecycleState = "open";
	#activation: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	readonly #runs = new JavaScriptRunQueue();
	readonly #kernelTools = new KernelToolHostPump(
		(message) => this.#slot.postMessage(message),
		() => this.#lifecycle === "open" && this.#slot.present,
	);
	readonly #toolCalls = new ToolCallQueue();
	readonly #children: WorkerChildren;
	readonly #memory: JavaScriptKernelMemory;
	readonly #activeCell: ActiveCellControl;
	readonly #recovery = new WorkerRecovery({
		runs: this.#runs,
		isOpen: () => this.#lifecycle === "open",
		ensureReady: () => this.#ensureReady(),
		startNext: () => this.#startNext(),
	});

	constructor(options: JavaScriptKernelOptions) {
		this.#options = options;
		this.#activeCell = new ActiveCellControl({
			runs: this.#runs,
			bounds: options.interruptBounds ?? DEFAULT_INTERRUPT_BOUNDS,
			post: (message) => this.#slot.postMessage(message),
			terminate: () => this.#terminate(),
			recover: () => void this.#recovery.recover(() => Promise.resolve()),
			clearToolCalls: () => this.#toolCalls.clear(),
		});
		this.#memory = new JavaScriptKernelMemory(options, () => this.#slot.processPid);
		this.#children = new WorkerChildren(options.collectOrphanedChildren);
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

	/** The kernel process's pid in process mode; none in worker mode or before it starts. */
	get processPid(): number | undefined {
		return this.#slot.processPid;
	}

	/** The last memory reading (a result, an idle collection, a query); none before the first. */
	get lastLiveBytes(): number | undefined {
		return this.#memory.lastLiveBytes;
	}

	/** A heap reading taken between cells without running one; nothing when no worker is live to ask. */
	async queryMemory(): Promise<JavaScriptMemoryReading | undefined> {
		const ready = this.#lifecycle === "open" && this.#slot.present && !this.#slot.startingUp;
		return await this.#memory.query(ready ? (message) => this.#slot.postMessage(message) : undefined);
	}

	get kernelToolEvents(): EventTarget {
		return this.#kernelTools.events;
	}

	describeKernelTools(names: readonly string[]): Promise<KernelToolsDescribeResult> {
		return this.#kernelTools.describe(names);
	}

	invokeKernelTool(
		request: KernelToolsInvokeRequest,
		options?: AbortSignal | KernelToolsInvokeOptions,
	): Promise<unknown> {
		return this.#kernelTools.invoke(request, options);
	}

	async run(input: JavaScriptRunInput): Promise<ResultMessage> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		const promise = this.#runs.enqueue(input);
		this.#activate();
		return await promise;
	}

	cancelQueued(cellId: string, reason: string): boolean {
		return this.#runs.remove(cellId, reason);
	}

	queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		return this.#runs.snapshot();
	}

	async interrupt(reason = "interrupted", cellId?: string): Promise<KernelInterruptHandle> {
		assertJavaScriptKernelOpen(this.#lifecycle, "interrupt");
		const active = this.#runs.active;
		if (cellId !== undefined && active?.input.cellId !== cellId) {
			const cancelled = this.cancelQueued(cellId, reason);
			return { stateRetained: Promise.resolve(true), ...(cancelled ? {} : { note: "cell not found" }) };
		}
		if (active && this.#hostEntries.abort(active, reason)) return { stateRetained: Promise.resolve(true) };
		if (!active) {
			// A worker still stuck in startup is not a healthy idle worker: retiring it is the only recovery.
			const wedgedInStartup = this.#slot.startingUp;
			this.#runs.settleAll(`JS cell interrupted: ${reason}`);
			if (!wedgedInStartup) return { stateRetained: Promise.resolve(true) };
			await this.#restartAfterStop();
			return { stateRetained: Promise.resolve(false) };
		}
		this.#activeCell.disarm();
		const stop = await this.#activeCell.stop(active, reason, `JS cell interrupted: ${reason}`);
		return { stateRetained: Promise.resolve(stop.retained), ...(stop.note === undefined ? {} : { note: stop.note }) };
	}

	async reset(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#terminate();
		this.#toolCalls.clear();
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#ensureReady();
		this.#startNext();
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		if (this.#lifecycle === "open") this.#slot.postMessage(message);
	}

	async nextToolCall(): Promise<ToolCallMessage> {
		return await this.#toolCalls.next();
	}

	async close(): Promise<void> {
		if (this.#closePromise) return await this.#closePromise;
		this.#slot.postMessage({ type: "close" });
		this.#lifecycle = "closing";
		const graceMs = this.#options.interruptBounds?.graceMs ?? JS_INTERRUPT_GRACE_MS;
		const hostEntriesStopped = this.#hostEntries.stopAll("JS kernel closed", graceMs);
		this.#runs.settleAll("JS kernel closed");
		this.#kernelTools.rejectAll(kernelToolError("kernel_tool_stale", "JS kernel closed"));
		this.#toolCalls.clear();
		const recovery = this.#recovery.inFlight;
		const closePromise = (async () => {
			await hostEntriesStopped;
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
		const activation = this.#recovery.bringUp();
		this.#activation = activation;
		void activation.then(() => {
			if (this.#activation === activation) this.#activation = null;
			if (this.#lifecycle === "open" && !this.#runs.active && this.#runs.hasWaiting) this.#activate();
		});
	}

	async #ensureReady(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		try {
			await this.#slot.ensureReady();
		} catch (error) {
			if (this.#options.isolation !== "process") throw error;
			// Process mode reports a failed start on the waiting cell, never as a rejection of run().
			if (this.#lifecycle === "open") this.#runs.settleAll(error instanceof Error ? error.message : String(error));
		}
	}

	#startNext(): void {
		if (this.#lifecycle !== "open" || this.#runs.active || !this.#slot.present) return;
		const next = this.#runs.startNext(performance.now());
		if (!next) return;
		const dispatch = dispatchCell(next.input, this.#moduleLoader, this.#options);
		if (dispatch.kind === "host") {
			this.#hostEntries.start(next, dispatch.host);
			return;
		}
		this.#activeCell.arm(next);
		for (const frame of dispatch.frames) this.#slot.postMessage(frame);
	}

	async #restartAfterStop(): Promise<void> {
		await this.#recovery.recover(() => this.#terminate());
	}

	#handleMessage(message: KernelToHostMessage): void {
		if (this.#kernelTools.consume(message) && message.type !== "tool-call") return;
		if (consumeControlFrame(message, { memory: this.#memory, runs: this.#runs, children: this.#children })) return;
		(this.#runs.active?.input.onMessage ?? this.#options.onMessage)?.(message);
		if (message.type === "tool-call") {
			this.#toolCalls.push(message);
			return;
		}
		if (message.type !== "result") return;
		const active = this.#runs.active;
		if (!active || active.input.cellId !== message.cellId) return;
		this.#activeCell.disarm();
		this.#runs.releaseActive(active);
		active.settledByWorker = true;
		this.#runs.settle(active, active.interruptResult ?? this.#memory.settled(message));
		this.#startNext();
		// A kernel over its memory ceiling restarts only once no cell is running or queued on it.
		if (this.#memory.claimRecycle(!this.#runs.active && !this.#runs.hasWaiting)) void this.#restartAfterStop();
	}

	#handleCrash(error: Error): void {
		const active = this.#runs.active;
		if (!active && this.#slot.startingUp) return;
		this.#activeCell.disarm();
		this.#kernelTools.rejectAll(kernelToolError("kernel_tool_stale", error.message));
		this.#memory.crashed(error);
		// A crash mid-install stops the install (process group killed, nothing published); it settles itself once stopped.
		if (active && !this.#hostEntries.abort(active, `JavaScript worker crashed: ${error.message}`)) {
			this.#runs.settleCrashed(active, error);
		}
		this.#toolCalls.clear();
		void this.#restartAfterStop();
	}

	/** Retire the worker, then whatever cell children it still owned. */
	async #terminate(): Promise<WorkerRetirement> {
		this.#activeCell.disarm();
		this.#kernelTools.rejectAll(kernelToolError("kernel_tool_stale", "JavaScript worker reset"));
		this.#memory.workerLost(new Error("JavaScript worker reset"));
		const retirement = await this.#slot.retire();
		await this.#children.retire();
		return retirement;
	}
}
