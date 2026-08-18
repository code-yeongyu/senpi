import type {
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	timeoutMs?: number;
	streamStartTimeoutMs?: number;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
	removedToolHints?: Record<string, string>;
	resolveUnknownToolCall?: AgentLoopConfig["resolveUnknownToolCall"];
	abortServerSideFallback?: boolean;
	/** Cursor exec-channel tool handlers; see {@link AgentLoopConfig.cursorExecHandlers}. */
	cursorExecHandlers?: AgentLoopConfig["cursorExecHandlers"];
}

export interface AgentContinuationOptions {
	/** Keep queued steering and follow-up input out of the continuation's first provider request only. */
	deferQueuedMessages?: boolean;
	/** Override the provider stream idle timeout for the continuation's first provider request only. */
	timeoutMs?: number;
	/** Override the provider stream-start timeout for the continuation's first provider request only. */
	streamStartTimeoutMs?: number;
}

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	private clearGeneration = 0;
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	getClearGeneration(): number {
		return this.clearGeneration;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	prepend(messages: AgentMessage[]): void {
		this.messages = [...messages, ...this.messages];
	}

	clear(): void {
		this.messages = [];
		this.clearGeneration++;
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
	suppressQueuedMessageDrain: boolean;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	public timeoutMs?: number;
	/** Optional bound on the wait for the first provider stream event. */
	public streamStartTimeoutMs?: number;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;
	/** Migration guidance returned when a removed tool name is called. */
	public removedToolHints: Record<string, string>;
	/** Optional call-time resolver for tools absent from the request context. */
	public resolveUnknownToolCall?: AgentLoopConfig["resolveUnknownToolCall"];
	/** Forwarded to the stream function; providers without server-side fallback ignore it. */
	public abortServerSideFallback?: boolean;
	/** Cursor exec-channel tool handlers; see {@link AgentLoopConfig.cursorExecHandlers}. */
	public cursorExecHandlers?: AgentLoopConfig["cursorExecHandlers"];

	constructor(options: AgentOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		this._state = createMutableAgentState(runtimeOptions.initialState);
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = runtimeOptions.transformContext;
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.shouldStopAfterTurn = runtimeOptions.shouldStopAfterTurn;
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.timeoutMs = runtimeOptions.timeoutMs;
		this.streamStartTimeoutMs = runtimeOptions.streamStartTimeoutMs;
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
		this.removedToolHints = runtimeOptions.removedToolHints ?? {};
		this.resolveUnknownToolCall = runtimeOptions.resolveUnknownToolCall;
		this.abortServerSideFallback = runtimeOptions.abortServerSideFallback;
		this.cursorExecHandlers = runtimeOptions.cursorExecHandlers;
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Keep queued steering and follow-up messages for an external owner after
	 * this run reaches agent_end, without changing the active abort signal.
	 * This is ownership suppression for one active run; terminal error/abort
	 * parking is a separate stop-reason policy enforced by the run lifecycle.
	 */
	suppressQueuedMessageDrain(): void {
		if (this.activeRun) {
			this.activeRun.suppressQueuedMessageDrain = true;
		}
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/**
	 * Continue by delivering queued input first when a compaction leaves custom context at the tail.
	 * Queue-first recovery takes precedence over `deferQueuedMessages`: the selected queued message is
	 * the continuation input, while timeout overrides still apply to its first provider request.
	 */
	async continueWithQueuedMessages(options: AgentContinuationOptions = {}): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		if (this._state.messages[this._state.messages.length - 1]?.role === "assistant") {
			await this.continue(options);
			return;
		}

		const queuedSteering = this.steeringQueue.drain();
		if (queuedSteering.length > 0) {
			await this.runPromptMessages(queuedSteering, {
				skipInitialSteeringPoll: true,
				initialRequestTimeoutMs: options.timeoutMs,
				initialRequestStreamStartTimeoutMs: options.streamStartTimeoutMs,
			});
			return;
		}

		const queuedFollowUps = this.followUpQueue.drain();
		if (queuedFollowUps.length > 0) {
			await this.runPromptMessages(queuedFollowUps, {
				initialRequestTimeoutMs: options.timeoutMs,
				initialRequestStreamStartTimeoutMs: options.streamStartTimeoutMs,
			});
			return;
		}

		await this.continue(options);
	}

	/**
	 * Continue from the current transcript. The last message must be a user or tool-result message.
	 * Queue deferral and timeout overrides apply only to the first provider request; later requests in
	 * the same run and later runs use the configured Agent defaults.
	 */
	async continue(options: AgentContinuationOptions = {}): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, {
					skipInitialSteeringPoll: true,
					initialRequestTimeoutMs: options.timeoutMs,
					initialRequestStreamStartTimeoutMs: options.streamStartTimeoutMs,
				});
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps, {
					initialRequestTimeoutMs: options.timeoutMs,
					initialRequestStreamStartTimeoutMs: options.streamStartTimeoutMs,
				});
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation(options);
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: {
			skipInitialSteeringPoll?: boolean;
			initialRequestTimeoutMs?: number;
			initialRequestStreamStartTimeoutMs?: number;
		} = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private async runContinuation(options: AgentContinuationOptions = {}): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig({
					skipInitialSteeringPoll: options.deferQueuedMessages,
					initialRequestTimeoutMs: options.timeoutMs,
					initialRequestStreamStartTimeoutMs: options.streamStartTimeoutMs,
				}),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(
		options: {
			skipInitialSteeringPoll?: boolean;
			initialRequestTimeoutMs?: number;
			initialRequestStreamStartTimeoutMs?: number;
		} = {},
	): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		let steeringQueueGeneration = this.steeringQueue.getClearGeneration();
		let followUpQueueGeneration = this.followUpQueue.getClearGeneration();
		const shouldStopAfterTurn = this.shouldStopAfterTurn;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			timeoutMs: this.timeoutMs,
			streamStartTimeoutMs: this.streamStartTimeoutMs,
			initialRequestTimeoutMs: options.initialRequestTimeoutMs,
			initialRequestStreamStartTimeoutMs: options.initialRequestStreamStartTimeoutMs,
			maxRetryDelayMs: this.maxRetryDelayMs,
			abortServerSideFallback: this.abortServerSideFallback,
			cursorExecHandlers: this.cursorExecHandlers,
			toolExecution: this.toolExecution,
			removedToolHints: this.removedToolHints,
			resolveUnknownToolCall: this.resolveUnknownToolCall,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			shouldStopAfterTurn: shouldStopAfterTurn
				? async (context) => await shouldStopAfterTurn(context, this.signal)
				: undefined,
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				steeringQueueGeneration = this.steeringQueue.getClearGeneration();
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => {
				followUpQueueGeneration = this.followUpQueue.getClearGeneration();
				return this.followUpQueue.drain();
			},
			restorePendingMessages: (queue, messages) => {
				if (queue === "steering") {
					if (this.steeringQueue.getClearGeneration() !== steeringQueueGeneration) return;
					this.steeringQueue.prepend(messages);
					return;
				}
				if (this.followUpQueue.getClearGeneration() !== followUpQueueGeneration) return;
				this.followUpQueue.prepend(messages);
			},
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController, suppressQueuedMessageDrain: false };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
			// A provider-returned terminal error/abort has no safe implicit owner for
			// queued work. Park it until an external retry/compaction owner continues,
			// or until a later admitted prompt drains it through the normal queue poll.
			while (
				!abortController.signal.aborted &&
				!this.activeRun?.suppressQueuedMessageDrain &&
				this.canDrainQueuedMessagesAfterRun() &&
				this.hasQueuedMessages()
			) {
				await this.runQueuedMessagesAfterAgentEnd(abortController.signal);
			}
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private canDrainQueuedMessagesAfterRun(): boolean {
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		return (
			lastMessage?.role !== "assistant" ||
			(lastMessage.stopReason !== "error" && lastMessage.stopReason !== "aborted")
		);
	}

	private async runQueuedMessagesAfterAgentEnd(signal: AbortSignal): Promise<void> {
		const queuedSteering = this.steeringQueue.drain();
		if (queuedSteering.length > 0) {
			await runAgentLoop(
				queuedSteering,
				this.createContextSnapshot(),
				this.createLoopConfig({ skipInitialSteeringPoll: true }),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
			return;
		}

		const queuedFollowUps = this.followUpQueue.drain();
		if (queuedFollowUps.length === 0) {
			return;
		}

		await runAgentLoop(
			queuedFollowUps,
			this.createContextSnapshot(),
			this.createLoopConfig(),
			(event) => this.processEvents(event),
			signal,
			this.streamFunction,
		);
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}

	/**
	 * Emit a host-generated event through the normal listener pipeline.
	 *
	 * Used by the Cursor exec bridge: bridge-run tools execute inside the
	 * provider stream, outside the loop's executor, so their
	 * `tool_execution_start`/`tool_execution_end` lifecycle must be injected
	 * here or the live tool card for a synthesized call never resolves.
	 * A bridge execution may settle after an aborted run has already ended; its
	 * late lifecycle event belongs to that finished run and must be discarded.
	 */
	async emitExternalEvent(event: AgentEvent, runSignal?: AbortSignal): Promise<void> {
		const activeSignal = this.activeRun?.abortController.signal;
		if (!activeSignal || (runSignal && runSignal !== activeSignal)) return;
		await this.processEvents(event);
	}
}
