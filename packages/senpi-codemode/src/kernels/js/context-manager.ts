import { Worker } from "node:worker_threads";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { createInlineWorker, type WorkerLike } from "./inline-worker.ts";

export type JavaScriptKernelMode = "worker" | "inline";

export interface JavaScriptKernelOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly workerEntryUrl?: URL;
}

export interface JavaScriptRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}

type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;
type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

interface QueuedRun {
	readonly input: JavaScriptRunInput;
	resolve(message: ResultMessage): void;
}

export class JavaScriptKernel {
	readonly #options: JavaScriptKernelOptions;
	#worker: WorkerLike | null = null;
	#mode: JavaScriptKernelMode = "worker";
	#ready: Promise<void> | null = null;
	#queue: QueuedRun[] = [];
	#active: QueuedRun | null = null;
	#timeout: NodeJS.Timeout | null = null;
	#toolWaiters: Array<(message: ToolCallMessage) => void> = [];
	#pendingToolCalls: ToolCallMessage[] = [];

	constructor(options: JavaScriptKernelOptions) {
		this.#options = options;
	}

	get mode(): JavaScriptKernelMode {
		return this.#mode;
	}

	async run(input: JavaScriptRunInput): Promise<ResultMessage> {
		await this.#ensureReady();
		const promise = new Promise<ResultMessage>((resolve) => {
			this.#queue.push({ input, resolve });
		});
		this.#startNext();
		return await promise;
	}

	async reset(): Promise<void> {
		await this.#terminate();
		this.#ready = null;
		await this.#ensureReady();
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		this.#worker?.postMessage(message);
	}

	async nextToolCall(): Promise<ToolCallMessage> {
		const pending = this.#pendingToolCalls.shift();
		if (pending) return pending;
		return await new Promise((resolve) => this.#toolWaiters.push(resolve));
	}

	async close(): Promise<void> {
		this.#worker?.postMessage({ type: "close" });
		await this.#terminate();
	}

	async #ensureReady(): Promise<void> {
		if (!this.#ready) this.#ready = this.#startWorker();
		return await this.#ready;
	}

	async #startWorker(): Promise<void> {
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#mode = worker.mode;
		const ready = waitForReady(worker);
		worker.onMessage((message) => this.#handleMessage(message));
		worker.onError((error) => this.#handleCrash(error));
		worker.postMessage({ type: "init", sessionId: this.#options.sessionId, connection: { port: 1, token: "local" } });
		try {
			await ready;
		} catch (error) {
			if (worker.mode === "inline") throw error;
			await worker.terminate().catch(() => undefined);
			const inline = createInlineWorker(this.#options.parallelPoolWidth);
			this.#worker = inline;
			this.#mode = "inline";
			const inlineReady = waitForReady(inline);
			inline.onMessage((message) => this.#handleMessage(message));
			inline.onError((crash) => this.#handleCrash(crash));
			inline.postMessage({
				type: "init",
				sessionId: this.#options.sessionId,
				connection: { port: 1, token: "local" },
			});
			await inlineReady;
		}
	}

	#spawnWorker(): WorkerLike {
		try {
			const url = this.#options.workerEntryUrl ?? new URL("./worker-entry.js", import.meta.url);
			const worker = new Worker(url, {
				workerData: { cwd: this.#options.cwd, parallelPoolWidth: this.#options.parallelPoolWidth },
			});
			return wrapNodeWorker(worker);
		} catch {
			return createInlineWorker(this.#options.parallelPoolWidth);
		}
	}

	#startNext(): void {
		if (this.#active || !this.#worker) return;
		const next = this.#queue.shift();
		if (!next) return;
		this.#active = next;
		if (next.input.timeoutMs) {
			this.#timeout = setTimeout(() => void this.#timeoutActive(next.input.cellId), next.input.timeoutMs);
		}
		this.#worker.postMessage({
			type: "run",
			cellId: next.input.cellId,
			code: next.input.code,
			timeoutMs: next.input.timeoutMs,
		});
	}

	async #timeoutActive(cellId: string): Promise<void> {
		const active = this.#active;
		if (!active || active.input.cellId !== cellId) return;
		const durationMs = active.input.timeoutMs ?? 0;
		active.resolve({
			type: "result",
			cellId,
			ok: false,
			error: { message: `JS cell timed out after ${durationMs}ms` },
			durationMs,
		});
		this.#active = null;
		await this.#terminate();
		this.#ready = null;
		await this.#ensureReady();
		this.#startNext();
	}

	#handleMessage(message: KernelToHostMessage): void {
		this.#options.onMessage?.(message);
		this.#active?.input.onMessage?.(message);
		if (message.type === "tool-call") {
			const waiter = this.#toolWaiters.shift();
			if (waiter) waiter(message);
			else this.#pendingToolCalls.push(message);
			return;
		}
		if (message.type !== "result") return;
		if (this.#timeout) clearTimeout(this.#timeout);
		this.#timeout = null;
		const active = this.#active;
		this.#active = null;
		active?.resolve(message);
		this.#startNext();
	}

	#handleCrash(error: Error): void {
		const active = this.#active;
		if (!active) return;
		this.#active = null;
		active.resolve({
			type: "result",
			cellId: active.input.cellId,
			ok: false,
			error: bridgeError(error),
			durationMs: 0,
		});
	}

	async #terminate(): Promise<void> {
		if (this.#timeout) clearTimeout(this.#timeout);
		this.#timeout = null;
		const worker = this.#worker;
		this.#worker = null;
		await worker?.terminate().catch(() => undefined);
	}
}

function waitForReady(worker: WorkerLike): Promise<void> {
	return new Promise((resolve, reject) => {
		const offMessage = worker.onMessage((message) => {
			if (message.type === "ready") {
				offMessage();
				offError();
				resolve();
			} else if (message.type === "init-failed") {
				offMessage();
				offError();
				reject(errorFromBridge(message.error));
			}
		});
		const offError = worker.onError((error) => {
			offMessage();
			offError();
			reject(error);
		});
	});
}

function wrapNodeWorker(worker: Worker): WorkerLike {
	return {
		mode: "worker",
		postMessage: (message) => worker.postMessage(message),
		onMessage(handler) {
			const listener = (message: KernelToHostMessage): void => handler(message);
			worker.on("message", listener);
			return () => worker.off("message", listener);
		},
		onError(handler) {
			worker.on("error", handler);
			return () => worker.off("error", handler);
		},
		async terminate() {
			await worker.terminate();
		},
	};
}

function errorFromBridge(error: { message: string; name?: string; stack?: string }): Error {
	const result = new Error(error.message);
	if (error.name) result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}

function bridgeError(error: Error): { message: string; name?: string; stack?: string } {
	return { message: error.message, name: error.name, stack: error.stack };
}
