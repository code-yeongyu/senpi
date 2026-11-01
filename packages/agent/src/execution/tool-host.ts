import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentToolCall, ToolExecutionMode } from "../types.ts";

/** Brain-minted identity and execution root; the executor treats the identity as opaque. */
export interface ExecutionScope {
	readonly id: string;
	readonly root: string;
}

/** The raw model calls, before name resolution, argument preparation, validation or hooks. */
export interface ToolHostCall {
	readonly scope: ExecutionScope;
	readonly calls: readonly AgentToolCall[];
	readonly mode: ToolExecutionMode;
}

export interface ExecutionPipelineWitness {
	readonly pipeline: "legacy" | "prepared";
	readonly toolCallId: string;
}

export interface ToolHostResult {
	readonly messages: ToolResultMessage[];
	readonly terminate: boolean;
}

export interface ToolHostOptions {
	readonly signal?: AbortSignal;
	/** Preserve tool events and ordered result-message events. The loop appends the returned messages to context. */
	readonly emit: (event: AgentEvent) => Promise<void> | void;
	/** Receipt metadata only: never an AgentEvent, tool result, provider payload or EQ observable. */
	readonly recordWitness?: (witness: ExecutionPipelineWitness) => Promise<void> | void;
}

export interface ToolHost {
	execute(call: ToolHostCall, options: ToolHostOptions): Promise<ToolHostResult>;
}
