import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type {
	ExecutionEntry,
	ExecutionKey,
	ExecutionLedger,
	FrozenCall,
} from "@earendil-works/pi-agent-core/conformance";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Today's per-call steps, as the executor runs them; the executor owns their order and the ledger around them. */
export interface PreparationPipeline {
	/** Exact name, then the host resolver (which may activate a lazy tool), then the alias rule. */
	resolve(call: AgentToolCall, context: AgentContext): Promise<AgentTool | undefined>;
	/** The ordered `tool_call` chain; PreToolUse is one handler in it. */
	beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined>;
	afterToolCall(context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined>;
	removedToolHint(name: string): string | undefined;
}

export interface PreparedExecutorOptions {
	readonly ledger: ExecutionLedger;
	/** The executor's authenticated identity: the actor of every executor-side ledger event. */
	readonly executor: string;
	readonly pipeline: PreparationPipeline;
	readonly clock?: () => number;
}

export interface PrepareRequest {
	readonly issuer: string;
	readonly generation: number;
	readonly workspace: string;
	readonly scope: string;
	/** The model's raw call; its id is the execution's command id. */
	readonly call: AgentToolCall;
	readonly assistantMessage: AssistantMessage;
	readonly context: AgentContext;
	/** Issuer-minted with the call, so a re-sent prepare matches its admission exactly. */
	readonly admittedAt: number;
	readonly leaseUntil: number;
	readonly reconcilable?: boolean;
	readonly signal?: AbortSignal;
}

/** `requestedName` is set when the model's name resolved to another tool; the caller adds today's notice. */
export type PrepareReply =
	| { readonly kind: "prepared"; readonly call: FrozenCall; readonly requestedName?: string }
	| { readonly kind: "blocked"; readonly result: AgentToolResult<unknown>; readonly requestedName?: string }
	| { readonly kind: "batch_abort"; readonly result: AgentToolResult<unknown> }
	| { readonly kind: "refused"; readonly reason: string };

export interface ReleaseRequest {
	readonly key: ExecutionKey;
	readonly generation: number;
	/** Verified identity of the releasing issuer, supplied by the endpoint. */
	readonly actor: { readonly id: string };
	readonly signal?: AbortSignal;
	readonly onUpdate?: AgentToolUpdateCallback<unknown>;
}

export type ReleaseReply =
	| {
			readonly kind: "settled";
			readonly toolCall: AgentToolCall;
			readonly result: AgentToolResult<unknown>;
			readonly isError: boolean;
	  }
	| { readonly kind: "replayed"; readonly entry: ExecutionEntry }
	| { readonly kind: "refused"; readonly reason: string };

export interface PreparedExecutor {
	prepare(request: PrepareRequest): Promise<PrepareReply>;
	release(request: ReleaseRequest): Promise<ReleaseReply>;
}
