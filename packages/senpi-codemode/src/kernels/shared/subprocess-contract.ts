import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { SubprocessSpawn } from "./subprocess-process.ts";

export interface KernelRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export interface SubprocessKernelOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}
