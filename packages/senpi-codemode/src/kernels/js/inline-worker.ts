import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { type CodemodeRuntimeAssetEnvironment, resolveCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import type { JavaScriptKernelMode } from "./kernel-contract.ts";
import { spawnNodeWorker } from "./worker-host.ts";

export interface JavaScriptInlineWorkerEntryUrlOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveInlineWorkerEntryUrl(options: JavaScriptInlineWorkerEntryUrlOptions = {}): URL {
	const localPath = options.localPath ?? join(dirname(fileURLToPath(import.meta.url)), "inline-worker-entry.js");
	return pathToFileURL(
		resolveCodemodeRuntimeAsset(localPath, join("kernels", "js", "inline-worker-entry.js"), options),
	);
}

export interface WorkerLike {
	readonly mode: JavaScriptKernelMode;
	postMessage(message: HostToKernelMessage): void;
	onMessage(handler: (message: KernelToHostMessage) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

export function createInlineWorker(cwd: string, parallelPoolWidth: number): WorkerLike {
	return spawnNodeWorker(resolveInlineWorkerEntryUrl(), cwd, parallelPoolWidth, "inline");
}
