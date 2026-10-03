import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalKernelRunInput } from "../../tool/types.ts";
import type { SessionEnvironment } from "../session-env.ts";
import type { KernelLifecycle } from "../shared/kernel-death.ts";
import type { KernelSpawnProcess } from "./process.ts";
import type { PythonStartupStage } from "./startup.ts";
import type { PythonTransportResult } from "./transport.ts";

export interface PythonKernelStartOptions extends KernelLifecycle {
	readonly interpreterPath: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly connection: BridgeConnectionConfig;
	readonly env?: NodeJS.ProcessEnv;
	/** Per-session PI_* values merged into the interpreter environment at spawn. */
	readonly sessionEnv?: SessionEnvironment;
	/** Python bootstrap inactivity guard per advancing stage, not a total readiness deadline. */
	readonly startupTimeoutMs?: number;
	/** Observes bootstrap control events without mixing them into cell output callbacks. */
	readonly onStartupProgress?: (stage: PythonStartupStage) => void;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly spawnProcess?: KernelSpawnProcess;
	/** Post-cell collection, notice, and ceiling thresholds sent on `init`; absent leaves memory unmanaged. */
	readonly memory?: KernelMemoryThresholds;
}

export type PythonKernelRunOptions = EvalKernelRunInput;

export type ResultMessage = PythonTransportResult;

export interface PendingRun {
	readonly input: PythonKernelRunOptions;
	readonly resolve: (result: ResultMessage) => void;
	readonly reject: (error: unknown) => void;
	startedAt: number | null;
	timeoutTimer: NodeJS.Timeout | null;
	escalationTimer?: NodeJS.Timeout;
	interruptReason?: string;
	/** Set while an interrupt outcome is pending; resolved once the kernel knows whether state survived. */
	resolveStateRetained?: (retained: boolean) => void;
	hostAbort?: AbortController;
}
