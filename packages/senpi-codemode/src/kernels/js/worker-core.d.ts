import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { WireAuthority } from "./permission-authority.mjs";

export interface WorkerCoreTransport {
	send(message: KernelToHostMessage): void;
	onMessage(handler: (message: HostToKernelMessage) => void): () => void;
	close(): void;
}

export interface WorkerCoreOptions {
	cwd: string;
	parallelPoolWidth: number;
	runAuthority?<T>(token: WireAuthority | undefined, run: () => T | Promise<T>): Promise<T>;
}

export interface WorkerCoreHandle {
	dispose(): void;
}

export function createWorkerCore(transport: WorkerCoreTransport, options: WorkerCoreOptions): WorkerCoreHandle;
