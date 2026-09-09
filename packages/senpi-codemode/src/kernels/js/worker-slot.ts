import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { WorkerLike } from "./inline-worker.ts";
import { retireWorker, type WorkerRetirement } from "./interrupt-bounds.ts";
import type { JavaScriptKernelMode } from "./kernel-contract.ts";
import type { JavaScriptKernelOptions } from "./local-module-loader.ts";
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

	get present(): boolean {
		return this.#worker !== null;
	}

	get startingUp(): boolean {
		return this.#startupAbort !== null;
	}

	postMessage(message: HostToKernelMessage): void {
		this.#worker?.postMessage(message);
	}

	async ensureReady(): Promise<void> {
		if (!this.#ready) {
			const generation = ++this.#generation;
			const controller = new AbortController();
			this.#startupAbort = controller;
			const ready = startWorkerWithInlineFallback(
				{
					options: this.#options,
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
		this.#worker = null;
		if (!worker) return "terminated";
		return await retireWorker(worker);
	}

	#publish(worker: WorkerLike, generation: number): void {
		if (!this.#listeners.isOpen() || generation !== this.#generation) throw new WorkerStartupCancelledError();
		this.#worker = worker;
		worker.onMessage((message) => {
			if (this.#isCurrent(worker, generation)) this.#listeners.onMessage(message);
		});
		worker.onError((error) => {
			if (this.#isCurrent(worker, generation)) this.#listeners.onCrash(error);
		});
	}

	#isCurrent(worker: WorkerLike, generation: number): boolean {
		return this.#listeners.isOpen() && this.#worker === worker && this.#generation === generation;
	}
}
