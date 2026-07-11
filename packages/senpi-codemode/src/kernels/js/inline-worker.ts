import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { JavaScriptKernelMode } from "./kernel-contract.ts";
import { spawnNodeWorker } from "./worker-host.ts";

export interface WorkerLike {
	readonly mode: JavaScriptKernelMode;
	postMessage(message: HostToKernelMessage): void;
	onMessage(handler: (message: KernelToHostMessage) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

export function createInlineWorker(cwd: string, parallelPoolWidth: number): WorkerLike {
	return spawnNodeWorker(new URL("./inline-worker-entry.js", import.meta.url), cwd, parallelPoolWidth, "inline");
}
