import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";

export interface WorkerCoreTransport {
	send(message: KernelToHostMessage): void;
	onMessage(handler: (message: HostToKernelMessage) => void): () => void;
	close(): void;
}

export interface WorkerCoreOptions {
	cwd: string;
	parallelPoolWidth: number;
}

export interface WorkerCoreHandle {
	dispose(): void;
}

export function createWorkerCore(transport: WorkerCoreTransport, options: WorkerCoreOptions): WorkerCoreHandle;
