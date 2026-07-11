import { Worker } from "node:worker_threads";
import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { WorkerLike } from "./inline-worker.ts";
import type { JavaScriptKernelMode } from "./kernel-contract.ts";

export class WorkerStartupCancelledError extends Error {
	readonly name = "WorkerStartupCancelledError";

	constructor() {
		super("JavaScript worker startup was cancelled");
	}
}

export class JavaScriptWorkerExitedError extends Error {
	readonly name = "JavaScriptWorkerExitedError";
	readonly exitCode: number;

	constructor(exitCode: number) {
		super(`JavaScript worker exited with code ${exitCode}`);
		this.exitCode = exitCode;
	}
}

export function spawnNodeWorker(
	url: URL,
	cwd: string,
	parallelPoolWidth: number,
	mode: JavaScriptKernelMode = "worker",
): WorkerLike {
	return wrapNodeWorker(
		new Worker(url, {
			workerData: { cwd, parallelPoolWidth },
		}),
		mode,
	);
}

export function waitForReady(worker: WorkerLike, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let offMessage = (): void => {};
		let offError = (): void => {};
		const cleanup = (): void => {
			offMessage();
			offError();
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			cleanup();
			reject(new WorkerStartupCancelledError());
		};
		offMessage = worker.onMessage((message) => {
			if (message.type === "ready") {
				cleanup();
				resolve();
			} else if (message.type === "init-failed") {
				cleanup();
				reject(errorFromBridge(message.error));
			}
		});
		offError = worker.onError((error) => {
			cleanup();
			reject(error);
		});
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function errorFromBridge(error: {
	readonly message: string;
	readonly name?: string;
	readonly stack?: string;
}): Error {
	const result = new Error(error.message);
	if (error.name) result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}

export function bridgeError(error: Error): {
	readonly message: string;
	readonly name?: string;
	readonly stack?: string;
} {
	return { message: error.message, name: error.name, stack: error.stack };
}

function wrapNodeWorker(worker: Worker, mode: JavaScriptKernelMode): WorkerLike {
	return {
		mode,
		postMessage: (message) => worker.postMessage(message),
		onMessage(handler) {
			const listener = (message: KernelToHostMessage): void => handler(message);
			worker.on("message", listener);
			return () => worker.off("message", listener);
		},
		onError(handler) {
			let reported = false;
			const report = (error: Error): void => {
				if (reported) return;
				reported = true;
				handler(error);
			};
			const onError = (error: Error): void => report(error);
			const onExit = (code: number): void => report(new JavaScriptWorkerExitedError(code));
			worker.on("error", onError);
			worker.on("exit", onExit);
			return () => {
				worker.off("error", onError);
				worker.off("exit", onExit);
			};
		},
		async terminate() {
			await worker.terminate();
		},
	};
}
