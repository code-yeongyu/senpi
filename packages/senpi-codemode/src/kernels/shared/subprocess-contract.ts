import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalKernelRunInput, EvalLanguage } from "../../tool/types.ts";
import type { SessionEnvironment } from "../session-env.ts";
import type { KernelLifecycle } from "./kernel-death.ts";
import type { FootprintReader } from "./kernel-memory-host.ts";
import type { SubprocessSpawn } from "./subprocess-process.ts";
import type { SubprocessStartupOptions } from "./subprocess-startup.ts";

export type KernelRunInput = EvalKernelRunInput;

export type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

/** Ceiling-only memory management: the host reads the interpreter footprint after each result. */
export interface SubprocessKernelMemory {
	readonly thresholds: KernelMemoryThresholds;
	readonly readFootprint: FootprintReader;
}

export interface SubprocessKernelOptions extends KernelLifecycle {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Per-session PI_* values merged into the interpreter environment at spawn. */
	readonly sessionEnv?: SessionEnvironment;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly memory?: SubprocessKernelMemory & { readonly language: EvalLanguage };
	/** Fails a start that stops making progress before `ready`; absent, the kernel waits for `ready` indefinitely. */
	readonly startup?: SubprocessStartupOptions;
}
