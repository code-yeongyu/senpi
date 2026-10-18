import type { MessagePort } from "node:worker_threads";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { WorkerLike } from "./inline-worker.ts";
import { retireWorker, type WorkerRetirement } from "./interrupt-bounds.ts";
import type { JavaScriptKernelMode } from "./kernel-contract.ts";
import type { JavaScriptKernelOptions } from "./local-module-loader.ts";
import { KernelWebViewClients } from "./webview-host.ts";
import { WorkerStartupCancelledError } from "./worker-host.ts";
import { startWorkerWithInlineFallback } from "./worker-startup.ts";

export interface WorkerSlotListeners {
	isOpen(): boolean;
	onMessage(message: KernelToHostMessage): void;
	onCrash(error: Error): void;
}

/** The kernel's current worker generation: startup with inline fallback, message fencing, bounded retirement. */
export class WorkerSlot {
	readonly #options: JavaScriptKernelOptions;
	readonly #listeners: WorkerSlotListeners;
	#worker: WorkerLike | null = null;
	#lastProcessPid: number | undefined;
	#webViews: KernelWebViewClients | null = null;
	#mode: JavaScriptKernelMode = "worker";
	#generation = 0;
	#ready: Promise<void> | null = null;
	#startupAbort: AbortController | null = null;

	constructor(options: JavaScriptKernelOptions, listeners: WorkerSlotListeners) {
		this.#options = options;
		this.#listeners = listeners;
	}

	get mode(): JavaScriptKernelMode {
		return this.#mode;
	}

	get processPid(): number | undefined {
		const worker = this.#worker;
		if (worker?.mode === "process") return worker.pid;
		return this.#lastProcessPid;
	}

	get present(): boolean {
		return this.#worker !== null;
	}

	get startingUp(): boolean {
		return this.#startupAbort !== null;
	}

	get generation(): number {
		return this.#generation;
	}

	postMessage(message: HostToKernelMessage, transfer?: readonly MessagePort[]): void {
		this.#worker?.postMessage(message, transfer);
	}

	async ensureReady(): Promise<void> {
		if (!this.#ready) {
			const generation = this.#generation === 0 ? ++this.#generation : this.#generation;
			const controller = new AbortController();
			this.#startupAbort = controller;
			const ready = startWorkerWithInlineFallback(
				{
					options: this.#options,
					kernelGeneration: generation,
					publish: (worker) => this.#publish(worker, generation),
					isCurrent: (worker) => this.#isCurrent(worker, generation),
					retire: (worker) => {
						if (this.#worker === worker) this.#worker = null;
					},
					canFallBackInline: () => this.#listeners.isOpen() && generation === this.#generation,
				},
				controller.signal,
			);
			this.#ready = ready;
			void ready.then(
				() => {
					if (this.#ready !== ready) return;
					this.#startupAbort = null;
					this.#mode = this.#worker?.mode ?? this.#mode;
				},
				() => {
					if (this.#ready === ready) {
						this.#ready = null;
						this.#startupAbort = null;
					}
				},
			);
		}
		return await this.#ready;
	}

	async retire(): Promise<WorkerRetirement> {
		this.#generation += 1;
		this.#startupAbort?.abort();
		this.#startupAbort = null;
		this.#ready = null;
		const worker = this.#worker;
		const webViews = this.#webViews;
		this.#worker = null;
		this.#webViews = null;
		const retirement = worker
			? await retireWorker(worker, this.#options.interruptBounds?.terminateDeadlineMs)
			: "terminated";
		await webViews?.release();
		return retirement;
	}

	#publish(worker: WorkerLike, generation: number): void {
		if (!this.#listeners.isOpen() || generation !== this.#generation) throw new WorkerStartupCancelledError();
		this.#worker = worker;
		if (worker.mode === "process") this.#lastProcessPid = worker.pid;
		const webViews = new KernelWebViewClients((message, transfer) => worker.postMessage(message, transfer));
		this.#webViews = webViews;
		worker.onMessage((message) => {
			if (!this.#isCurrent(worker, generation) || webViews.consume(message)) return;
			this.#listeners.onMessage(message);
		});
		worker.onError((error) => {
			if (this.#isCurrent(worker, generation)) this.#listeners.onCrash(error);
		});
	}

	#isCurrent(worker: WorkerLike, generation: number): boolean {
		return this.#listeners.isOpen() && this.#worker === worker && this.#generation === generation;
	}
}
