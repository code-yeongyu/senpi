import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { createInlineWorker, type WorkerLike } from "./inline-worker.ts";
import {
	assertJavaScriptKernelOpen,
	type JavaScriptKernelMode,
	type JavaScriptRunInput,
	type LifecycleState,
	type ResultMessage,
	type ToolCallMessage,
} from "./kernel-contract.ts";
import { type JavaScriptKernelOptions, LocalModuleLoader, localBridgeConnection } from "./local-module-loader.ts";
import { JavaScriptRunQueue, type PendingJavaScriptRun, stoppedResult } from "./run-queue.ts";
import { bridgeError, spawnNodeWorker, WorkerStartupCancelledError, waitForReady } from "./worker-host.ts";

export { JavaScriptKernelClosedError, type JavaScriptKernelMode, type JavaScriptRunInput } from "./kernel-contract.ts";
export type { JavaScriptKernelOptions } from "./local-module-loader.ts";

export class JavaScriptKernel {
	readonly #options: JavaScriptKernelOptions;
	readonly #moduleLoader: LocalModuleLoader;
	#worker: WorkerLike | null = null;
	#mode: JavaScriptKernelMode = "worker";
	#lifecycle: LifecycleState = "open";
	#ready: Promise<void> | null = null;
	#startupAbort: AbortController | null = null;
	#generation = 0;
	#activation: Promise<void> | null = null;
	#recovery: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	readonly #runs = new JavaScriptRunQueue();
	#timeout: NodeJS.Timeout | null = null;
	#toolWaiters: Array<(message: ToolCallMessage) => void> = [];
	#pendingToolCalls: ToolCallMessage[] = [];

	constructor(options: JavaScriptKernelOptions) {
		this.#options = options;
		this.#moduleLoader = new LocalModuleLoader(options);
	}

	get mode(): JavaScriptKernelMode {
		return this.#mode;
	}

	async run(input: JavaScriptRunInput): Promise<ResultMessage> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		const promise = this.#runs.enqueue(input);
		this.#activate();
		return await promise;
	}

	async interrupt(reason = "interrupted"): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "interrupt");
		const active = this.#runs.active;
		const target = this.#runs.takeInterruptTarget();
		if (!target) return;
		if (target === active) this.#clearTimeout();
		this.#runs.settle(target, stoppedResult(target.input.cellId, `JS cell interrupted: ${reason}`));
		await this.#restartAfterStop();
	}

	async reset(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#terminate();
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#ensureReady();
		this.#startNext();
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		if (this.#lifecycle === "open") this.#worker?.postMessage(message);
	}

	async nextToolCall(): Promise<ToolCallMessage> {
		const pending = this.#pendingToolCalls.shift();
		if (pending) return pending;
		return await new Promise((resolve) => this.#toolWaiters.push(resolve));
	}

	async close(): Promise<void> {
		if (this.#closePromise) return await this.#closePromise;
		this.#worker?.postMessage({ type: "close" });
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
		if (!this.#ready) {
			const generation = ++this.#generation;
			const controller = new AbortController();
			this.#startupAbort = controller;
			const ready = this.#startWorker(generation, controller.signal);
			this.#ready = ready;
			void ready.then(
				() => {
					if (this.#ready === ready) this.#startupAbort = null;
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

	async #startWorker(generation: number, signal: AbortSignal): Promise<void> {
		let worker = this.#spawnWorker();
		this.#publishWorker(worker, generation);
		try {
			await this.#initializeWorker(worker, signal);
			return;
		} catch (error) {
			if (!this.#isCurrent(worker, generation) || error instanceof WorkerStartupCancelledError) {
				await worker.terminate();
				throw new WorkerStartupCancelledError();
			}
			if (worker.mode === "inline") throw error;
			this.#worker = null;
			await worker.terminate();
		}
		if (this.#lifecycle !== "open" || generation !== this.#generation) throw new WorkerStartupCancelledError();
		worker = createInlineWorker(this.#options.cwd, this.#options.parallelPoolWidth);
		this.#publishWorker(worker, generation);
		await this.#initializeWorker(worker, signal);
	}

	#spawnWorker(): WorkerLike {
		try {
			const url = this.#options.workerEntryUrl ?? new URL("./worker-entry.js", import.meta.url);
			return spawnNodeWorker(url, this.#options.cwd, this.#options.parallelPoolWidth);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			return createInlineWorker(this.#options.cwd, this.#options.parallelPoolWidth);
		}
	}

	#publishWorker(worker: WorkerLike, generation: number): void {
		if (this.#lifecycle !== "open" || generation !== this.#generation) throw new WorkerStartupCancelledError();
		this.#worker = worker;
		this.#mode = worker.mode;
		worker.onMessage((message) => {
			if (this.#isCurrent(worker, generation)) this.#handleMessage(message);
		});
		worker.onError((error) => {
			if (this.#isCurrent(worker, generation)) this.#handleCrash(error);
		});
	}

	async #initializeWorker(worker: WorkerLike, signal: AbortSignal): Promise<void> {
		const ready = waitForReady(worker, signal);
		worker.postMessage({
			type: "init",
			sessionId: this.#options.sessionId,
			connection: localBridgeConnection(this.#options),
		});
		await ready;
	}

	#isCurrent(worker: WorkerLike, generation: number): boolean {
		return this.#lifecycle === "open" && this.#worker === worker && this.#generation === generation;
	}

	#startNext(): void {
		if (this.#lifecycle !== "open" || this.#runs.active || !this.#worker) return;
		const next = this.#runs.startNext(performance.now());
		if (!next) return;
		if (next.input.timeoutMs) {
			this.#timeout = setTimeout(() => void this.#timeoutActive(next), next.input.timeoutMs);
		}
		this.#worker.postMessage({
			type: "run",
			cellId: next.input.cellId,
			code: this.#moduleLoader.prepareCell(next.input.code),
			timeoutMs: next.input.timeoutMs,
		});
	}

	async #timeoutActive(run: PendingJavaScriptRun): Promise<void> {
		if (!this.#runs.releaseActive(run)) return;
		const durationMs = run.input.timeoutMs ?? 0;
		this.#runs.settle(run, {
			type: "result",
			cellId: run.input.cellId,
			ok: false,
			error: { message: `JS cell timed out after ${durationMs}ms` },
			durationMs,
		});
		await this.#restartAfterStop();
	}

	async #restartAfterStop(): Promise<void> {
		if (this.#recovery) return await this.#recovery;
		const recovery = this.#performRestartAfterStop();
		this.#recovery = recovery;
		try {
			await recovery;
		} finally {
			if (this.#recovery === recovery) this.#recovery = null;
		}
	}

	async #performRestartAfterStop(): Promise<void> {
		try {
			await this.#terminate();
			if (this.#lifecycle !== "open") return;
			await this.#ensureReady();
			if (this.#lifecycle === "open") this.#startNext();
		} catch (error) {
			if (error instanceof WorkerStartupCancelledError) return;
			this.#runs.rejectWaiting(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#handleMessage(message: KernelToHostMessage): void {
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
		this.#runs.settle(active, message);
		this.#startNext();
	}

	#handleCrash(error: Error): void {
		const active = this.#runs.active;
		if (!active && this.#startupAbort) return;
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

	async #terminate(): Promise<void> {
		this.#clearTimeout();
		this.#generation += 1;
		this.#startupAbort?.abort();
		this.#startupAbort = null;
		this.#ready = null;
		const worker = this.#worker;
		this.#worker = null;
		if (worker) await worker.terminate();
	}
}
