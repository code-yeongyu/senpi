import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { KernelSpawnProcess } from "./process.ts";
import type { PythonTransportResult } from "./transport.ts";

export interface PythonKernelStartOptions {
	readonly interpreterPath: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly connection: BridgeConnectionConfig;
	readonly env?: NodeJS.ProcessEnv;
	readonly startupTimeoutMs?: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly spawnProcess?: KernelSpawnProcess;
}

export interface PythonKernelRunOptions {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export type ResultMessage = PythonTransportResult;

export interface PendingRun {
	readonly input: PythonKernelRunOptions;
	readonly resolve: (result: ResultMessage) => void;
	readonly reject: (error: unknown) => void;
	startedAt: number | null;
	timeoutTimer: NodeJS.Timeout | null;
	escalationTimer?: NodeJS.Timeout;
	interruptReason?: string;
}
