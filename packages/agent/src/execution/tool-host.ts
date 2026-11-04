import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentContext, AgentEvent, AgentToolCall, ToolExecutionMode } from "../types.ts";

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
	readonly pipeline: "prepared";
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
	/**
	 * The loop's own view of the batch, for a host that runs in the loop's process and runs today's preparation steps
	 * (the prepared pipeline): the context and the assistant message that issued the calls. A remote host never reads it.
	 */
	readonly local?: { readonly context: AgentContext; readonly assistantMessage: AssistantMessage };
}

/** The loop had a tool batch to run on its default pipeline but no `batchStoreFactory`; it refuses instead of guessing a store. */
export class BatchStoreMissingError extends Error {
	readonly code = "batch_store_missing";

	constructor() {
		super("agent loop: no batchStoreFactory configured for the prepared pipeline; pass one (or a toolHost)");
		this.name = "BatchStoreMissingError";
	}
}

export interface ToolHost {
	execute(call: ToolHostCall, options: ToolHostOptions): Promise<ToolHostResult>;
}
