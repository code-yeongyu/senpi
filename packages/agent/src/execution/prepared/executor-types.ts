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
} from "../../types.ts";
import type { ExecutionEntry, ExecutionKey, FrozenCall } from "../ledger-types.ts";
import type { ExecutionLedger } from "../ledger.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Today's per-call steps, as the executor runs them; the executor owns their order and the ledger around them. */
export interface PreparationPipeline {
	/** Exact name, then the host resolver (which may activate a lazy tool), then the alias rule. */
	resolve(call: AgentToolCall, context: AgentContext): Promise<AgentTool | undefined>;
	/** The ordered `tool_call` chain; PreToolUse is one handler in it. */
	beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined>;
	afterToolCall(context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined>;
	removedToolHint(name: string): string | undefined;
	/**
	 * Called once per call after its freeze is recorded and before its body is stored: carries the facts the
	 * `tool_call` preflight attached to the prepared arguments object over to the frozen copy the tool will execute
	 * (senpi#5795). Synchronous and must never throw: a throw here would turn into a block after the freeze.
	 */
	afterFreeze(prepared: unknown, frozen: unknown): void;
}

export interface PreparedExecutorOptions {
	readonly ledger: ExecutionLedger;
	/** The executor's authenticated identity: the actor of every executor-side ledger event. */
	readonly executor: string;
	readonly pipeline: PreparationPipeline;
	readonly clock?: () => number;
	/**
	 * Gate B for a cross-machine executor (design 5.6.1): a frozen call that differs from what Gate A authorized and
	 * needs consent waits for an approval of its frozen digest. Absent on fused and split-local executors (K3): no wait.
	 */
	readonly consent?: ConsentClassifier;
}

/** The engine's own permission classification of a call, without prompting anyone. */
export interface ConsentClassifier {
	needsConsent(call: { readonly name: string; readonly args: unknown }): boolean;
}

export interface PrepareRequest {
	readonly issuer: string;
	readonly generation: number;
	readonly workspace: string;
	readonly scope: string;
	/** The model's raw call; its id is the execution's command id unless `commandId` names another. */
	readonly call: AgentToolCall;
	/** The execution's command id when the call's own id cannot be one: the model may repeat a call id in one message. */
	readonly commandId?: string;
	readonly assistantMessage: AssistantMessage;
	readonly context: AgentContext;
	/** Issuer-minted with the call, so a re-sent prepare matches its admission exactly. */
	readonly admittedAt: number;
	readonly leaseUntil: number;
	readonly reconcilable?: boolean;
	readonly signal?: AbortSignal;
	/** The raw request digest Gate A approved, if the brain asked; an identical frozen call needs no second approval. */
	readonly authorizedDigest?: string;
}

/** `requestedName` is set when the model's name resolved to another tool; the caller adds today's notice. */
export type PrepareReply =
	| { readonly kind: "prepared"; readonly call: FrozenCall; readonly requestedName?: string }
	| { readonly kind: "prepared_awaiting_consent"; readonly call: FrozenCall; readonly requestedName?: string }
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
	/** Like `onUpdate`, built from the prepared call it updates (renamed and prepared as the body runs it); wins over it. */
	readonly onUpdateFor?: (toolCall: AgentToolCall) => AgentToolUpdateCallback<unknown>;
}

export type ReleaseReply =
	| {
			readonly kind: "settled";
			readonly toolCall: AgentToolCall;
			readonly result: AgentToolResult<unknown>;
			readonly isError: boolean;
			/** Set when the model's name resolved to another tool; the caller adds today's correction notice. */
			readonly requestedName?: string;
	  }
	| { readonly kind: "aborted"; readonly result: AgentToolResult<unknown> }
	| { readonly kind: "replayed"; readonly entry: ExecutionEntry }
	| { readonly kind: "refused"; readonly reason: string };

export interface ConsentRequest {
	readonly key: ExecutionKey;
	readonly generation: number;
	/** Verified identity of the issuer applying the approval, supplied by the endpoint. */
	readonly actor: { readonly id: string };
	/** The approval binds this frozen call; an approval of anything else is refused. */
	readonly frozenDigest: string;
}

export type ConsentReply =
	| { readonly kind: "prepared" }
	| { readonly kind: "replayed"; readonly entry: ExecutionEntry }
	| { readonly kind: "refused"; readonly reason: string };

export interface PreparedExecutor {
	prepare(request: PrepareRequest): Promise<PrepareReply>;
	release(request: ReleaseRequest): Promise<ReleaseReply>;
	consent(request: ConsentRequest): Promise<ConsentReply>;
}
