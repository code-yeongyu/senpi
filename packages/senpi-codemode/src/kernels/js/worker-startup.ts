import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CodemodeRuntimeAssetEnvironment, requireCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import { createInlineWorker, type WorkerLike } from "./inline-worker.ts";
import { retireWorker } from "./interrupt-bounds.ts";
import { resolveKernelToolNameSource } from "./kernel-contract.ts";
import { type JavaScriptKernelOptions, localBridgeConnection } from "./local-module-loader.ts";
import { resolveJsProcessEntryUrl, spawnProcessWorker } from "./process-worker.ts";
import { spawnNodeWorker, WorkerStartupCancelledError, waitForReady } from "./worker-host.ts";

export interface JavaScriptWorkerEntryUrlOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveJsWorkerEntryUrl(options: JavaScriptWorkerEntryUrlOptions = {}): URL {
	const localPath = options.localPath ?? join(dirname(fileURLToPath(import.meta.url)), "worker-entry.js");
	return pathToFileURL(requireCodemodeRuntimeAsset(localPath, join("kernels", "js", "worker-entry.js"), options));
}

/**
 * How long a process-mode kernel child gets to report ready. A child that a starved host never schedules would
 * otherwise hold every queued cell forever: no cell's own timeout is armed until the kernel is up.
 */
export const PROCESS_STARTUP_DEADLINE_MS = 30_000;

export class ProcessKernelStartupTimeoutError extends Error {
	constructor(deadlineMs: number) {
		super(
			`JavaScript kernel process did not become ready within ${deadlineMs / 1000}s; it was stopped, and the next cell starts a fresh one`,
		);
		this.name = "ProcessKernelStartupTimeoutError";
	}
}

export interface WorkerStartupHooks {
	readonly options: JavaScriptKernelOptions;
	readonly kernelGeneration: number;
	/** Wires the worker into the kernel; throws `WorkerStartupCancelledError` once the generation is stale. */
	publish(worker: WorkerLike): void;
	isCurrent(worker: WorkerLike): boolean;
	retire(worker: WorkerLike): void;
	canFallBackInline(): boolean;
}

export async function startWorkerWithInlineFallback(hooks: WorkerStartupHooks, signal: AbortSignal): Promise<void> {
	let worker = spawnWorker(hooks.options);
	hooks.publish(worker);
	try {
		await initializeWorker(worker, hooks, signal);
		return;
	} catch (error) {
		if (!hooks.isCurrent(worker) || error instanceof WorkerStartupCancelledError) {
			await worker.terminate();
			throw new WorkerStartupCancelledError();
		}
		// Process mode never falls back: the user asked for isolation, so a failed start stays visible. The child that
		// failed to start is stopped (bounded), so a stuck one is not left behind.
		if (worker.mode === "process") {
			hooks.retire(worker);
			await retireWorker(worker);
			throw error;
		}
		if (worker.mode === "inline") throw error;
		hooks.retire(worker);
		await worker.terminate();
	}
	if (!hooks.canFallBackInline()) throw new WorkerStartupCancelledError();
	worker = createInlineWorker(hooks.options.cwd, hooks.options.parallelPoolWidth);
	hooks.publish(worker);
	await initializeWorker(worker, hooks, signal);
}

function spawnWorker(options: JavaScriptKernelOptions): WorkerLike {
	if (options.isolation === "process") {
		const url = resolveJsProcessEntryUrl();
		return spawnProcessWorker(url, {
			cwd: options.cwd,
			parallelPoolWidth: options.parallelPoolWidth,
			...(options.processCommandPath === undefined ? {} : { searchPath: options.processCommandPath }),
			...(options.processExecPath === undefined ? {} : { execPath: options.processExecPath }),
		});
	}
	try {
		const url = options.workerEntryUrl ?? resolveJsWorkerEntryUrl();
		return spawnNodeWorker(url, options.cwd, options.parallelPoolWidth);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return createInlineWorker(options.cwd, options.parallelPoolWidth);
	}
}

async function initializeWorker(worker: WorkerLike, hooks: WorkerStartupHooks, signal: AbortSignal): Promise<void> {
	const ready =
		worker.mode === "process"
			? withStartupDeadline(waitForReady(worker, signal), hooks.options)
			: waitForReady(worker, signal);
	const options = hooks.options;
	worker.postMessage({
		type: "init",
		sessionId: options.sessionId,
		connection: localBridgeConnection(options),
		kernelGeneration: hooks.kernelGeneration,
		hostToolNames: resolveKernelToolNameSource(options.hostToolNames),
		foreignLanguageNames: resolveKernelToolNameSource(options.foreignLanguageNames),
		...(options.sessionEnv === undefined ? {} : { sessionEnv: options.sessionEnv }),
		...(options.memory === undefined ? {} : { memory: options.memory }),
		...(options.kernelToolsEnabled === false ? { kernelToolsDisabled: true } : {}),
	});
	await ready;
}

function withStartupDeadline(ready: Promise<void>, options: JavaScriptKernelOptions): Promise<void> {
	const deadlineMs = options.processStartupDeadlineMs ?? PROCESS_STARTUP_DEADLINE_MS;
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new ProcessKernelStartupTimeoutError(deadlineMs)), deadlineMs);
	});
	// When the deadline wins, the stopped child's readiness promise rejects later; that outcome is already reported.
	ready.catch(() => {});
	return Promise.race([ready, expired]).finally(() => clearTimeout(timer));
}
