import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalKernelRunInput } from "../../tool/types.ts";
import type { SessionEnvironment } from "../session-env.ts";
import type { KernelLifecycle } from "../shared/kernel-death.ts";
import type { PeerKernelToolsDescribe } from "./kernel-tools-host.ts";
import type { KernelSpawnProcess, KillProcessGroup } from "./process.ts";
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
	/** How long a starting interpreter may show no stage change, output or CPU use before startup fails. */
	readonly startupTimeoutMs?: number;
	/** Total startup backstop for an interpreter that stays busy but never becomes ready. */
	readonly startupCeilingMs?: number;
	/** Reads the interpreter's CPU time; the default reads the process group (Unix) or the process (Windows). */
	readonly readCpuTime?: (pid: number | undefined) => bigint | undefined;
	/** Signals the interpreter's process group when it is retired; the default is `process.kill(-pid, signal)`. */
	readonly killProcessGroup?: KillProcessGroup;
	/** Observes bootstrap control events without mixing them into cell output callbacks. */
	readonly onStartupProgress?: (stage: PythonStartupStage) => void;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly spawnProcess?: KernelSpawnProcess;
	/** Post-cell collection, notice, and ceiling thresholds sent on `init`; absent leaves memory unmanaged. */
	readonly memory?: KernelMemoryThresholds;
	/** The JavaScript kernel's describe, so a name defined in both languages is a describe-time collision. */
	readonly peerKernelToolsDescribe?: PeerKernelToolsDescribe;
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
	hostDone?: Promise<ResultMessage>;
}
