import {
	type AssistantMessage,
	type ImageContent,
	type Model,
	streamSimple,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Agent, type QueueMode } from "../agent.js";
import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "../types.js";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.js";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction.js";
import { formatPromptTemplateInvocation } from "./prompt-templates.js";
import { formatSkillInvocation } from "./skills.js";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Session,
	Skill,
} from "./types.js";

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	let hasHeaders = false;
	for (const entry of headers) {
		if (!entry) continue;
		Object.assign(merged, entry);
		hasHeaders = true;
	}
	return hasHeaders ? merged : undefined;
}

function hasOwn(object: object, key: PropertyKey): boolean {
	return Object.hasOwn(object, key);
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (hasOwn(patch, "transport")) result.transport = patch.transport;
	if (hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;

	if (hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly agent: Agent;
	readonly env: ExecutionEnv;
	private session: Session;
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private nextTurnQueue: AgentMessage[] = [];
	private phase: AgentHarnessPhase = "idle";
	private steerQueue: UserMessage[] = [];
	private followUpQueue: UserMessage[] = [];
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private streamOptions: AgentHarnessStreamOptions;
	private appliedStreamOptions: AgentHarnessStreamOptions = {};
	private appliedSessionId?: string;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	private tools = new Map<string, TTool>();
	private listeners = new Set<
		(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void
	>();
	private hooks = new Map<keyof AgentHarnessEventResultMap, Set<(event: any) => Promise<any> | any>>();

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.agent = new Agent({
			initialState: {
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				tools: options.tools ?? [],
			},
			streamFn: async (model, context, streamOptions) => {
				const auth = await this.getApiKeyAndHeaders?.(model);
				const snapshotOptions: AgentHarnessStreamOptions = {
					...this.appliedStreamOptions,
					headers: mergeHeaders(this.appliedStreamOptions.headers, auth?.headers),
				};
				const requestOptions = await this.emitBeforeProviderRequest(
					model,
					this.appliedSessionId ?? "",
					snapshotOptions,
				);
				return streamSimple(model, context, {
					cacheRetention: requestOptions.cacheRetention,
					headers: requestOptions.headers,
					maxRetries: requestOptions.maxRetries,
					maxRetryDelayMs: requestOptions.maxRetryDelayMs,
					metadata: requestOptions.metadata,
					onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
					onResponse: async (response) => {
						const headers = { ...(response.headers as Record<string, string>) };
						await this.emitOwn(
							{ type: "after_provider_response", status: response.status, headers },
							this.agent.signal,
						);
					},
					reasoning: streamOptions?.reasoning,
					signal: streamOptions?.signal,
					sessionId: this.appliedSessionId,
					timeoutMs: requestOptions.timeoutMs,
					transport: requestOptions.transport,
					apiKey: auth?.apiKey,
				});
			},
			steeringMode: options.steeringMode,
			followUpMode: options.followUpMode,
		});
		this.env = options.env;
		this.session = options.session;
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.systemPrompt = options.systemPrompt;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? this.agent.state.thinkingLevel;
		this.activeToolNames = options.activeToolNames ?? (options.tools ?? []).map((tool) => tool.name);
		this.agent.state.model = this.model;
		this.agent.state.thinkingLevel = this.thinkingLevel;
		this.agent.transformContext = async (messages) => {
			const result = await this.emitHook({ type: "context", messages: [...messages] });
			return result?.messages ?? messages;
		};
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const result = await this.emitHook({
				type: "tool_call",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: args as Record<string, unknown>,
			});
			return result ? { block: result.block, reason: result.reason } : undefined;
		};
		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const patch = await this.emitHook({
				type: "tool_result",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});
			return patch
				? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
				: undefined;
		};
		this.agent.prepareNextTurn = async () => {
			await this.flushPendingSessionWrites();
			const turnState = await this.createTurnState();
			this.applyTurnState(turnState);
			return {
				context: {
					systemPrompt: turnState.systemPrompt,
					messages: turnState.messages.slice(),
					tools: turnState.activeTools.slice(),
				},
				model: turnState.model,
				thinkingLevel: turnState.thinkingLevel,
			};
		};
		this.agent.subscribe(async (event, signal) => {
			await this.handleAgentEvent(event, signal);
		});
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}

	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}

	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.hooks.get(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			const result = await handler(event);
			if (result !== undefined) {
				lastResult = result;
			}
		}
		return lastResult;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.hooks.get("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			const result = await handler({
				type: "before_provider_request",
				model,
				sessionId,
				streamOptions: cloneStreamOptions(current),
			});
			if (result?.streamOptions) {
				current = applyStreamOptionsPatch(current, result.streamOptions);
			}
		}
		return current;
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.hooks.get("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			const result = await handler({ type: "before_provider_payload", model, payload: current });
			if (result !== undefined) {
				current = result.payload;
			}
		}
		return current;
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		});
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
		}
		return {
			messages: context.messages,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
	}

	private applyTurnState(turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): void {
		this.agent.state.messages = turnState.messages;
		this.appliedStreamOptions = cloneStreamOptions(turnState.streamOptions);
		this.appliedSessionId = turnState.sessionId;
		this.agent.state.systemPrompt = turnState.systemPrompt;
		this.agent.state.model = turnState.model;
		this.agent.state.thinkingLevel = turnState.thinkingLevel;
		this.agent.state.tools = turnState.activeTools;
	}

	private validateToolNames(toolNames: string[]): void {
		const missing = toolNames.filter((name) => !this.tools.has(name));
		if (missing.length > 0) throw new Error(`Unknown tool(s): ${missing.join(", ")}`);
	}

	private async flushPendingSessionWrites(): Promise<void> {
		const writes = this.pendingSessionWrites;
		this.pendingSessionWrites = [];
		for (const write of writes) {
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			}
		}
	}

	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		await this.emitAny(event, signal);
		if (event.type === "message_start" && event.message.role === "user") {
			const steerIndex = this.steerQueue.indexOf(event.message);
			if (steerIndex !== -1) {
				this.steerQueue.splice(steerIndex, 1);
				await this.emitQueueUpdate();
			} else {
				const followUpIndex = this.followUpQueue.indexOf(event.message);
				if (followUpIndex !== -1) {
					this.followUpQueue.splice(followUpIndex, 1);
					await this.emitQueueUpdate();
				}
			}
		}
		if (event.type === "message_end") {
			await this.session.appendMessage(event.message);
		}
		if (event.type === "turn_end") {
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			await this.emitOwn({
				type: "save_point",
				hadPendingMutations,
			});
		}
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			this.phase = "idle";
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
		}
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		this.applyTurnState(turnState);
		const beforeLength = this.agent.state.messages.length;
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
		if (this.nextTurnQueue.length > 0) {
			messages = [...this.nextTurnQueue, messages[0]!];
			this.nextTurnQueue = [];
			await this.emitQueueUpdate();
		}
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...beforeResult.messages, ...messages];
		if (beforeResult?.systemPrompt) this.agent.state.systemPrompt = beforeResult.systemPrompt;
		try {
			await this.agent.prompt(messages);
		} finally {
			await this.flushPendingSessionWrites();
		}
		let response: AssistantMessage | undefined;
		const newMessages = this.agent.state.messages.slice(beforeLength);
		for (let i = newMessages.length - 1; i >= 0; i--) {
			const message = newMessages[i]!;
			if (message.role === "assistant") {
				response = message;
				break;
			}
		}
		if (!response) throw new Error("AgentHarness prompt completed without an assistant message");
		return response;
	}

	async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new Error("AgentHarness is busy");
		this.phase = "turn";
		try {
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			this.phase = "idle";
			throw error;
		}
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new Error("AgentHarness is busy");
		this.phase = "turn";
		try {
			const turnState = await this.createTurnState();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new Error(`Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			this.phase = "idle";
			throw error;
		}
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new Error("AgentHarness is busy");
		this.phase = "turn";
		try {
			const turnState = await this.createTurnState();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new Error(`Unknown prompt template: ${name}`);
			return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
		} catch (error) {
			this.phase = "idle";
			throw error;
		}
	}

	steer(text: string, options?: { images?: ImageContent[] }): void {
		if (this.phase === "idle") throw new Error("Cannot steer while idle");
		const message = createUserMessage(text, options?.images);
		this.steerQueue.push(message);
		this.agent.steer(message);
		void this.emitQueueUpdate();
	}

	followUp(text: string, options?: { images?: ImageContent[] }): void {
		if (this.phase === "idle") throw new Error("Cannot follow up while idle");
		const message = createUserMessage(text, options?.images);
		this.followUpQueue.push(message);
		this.agent.followUp(message);
		void this.emitQueueUpdate();
	}

	nextTurn(text: string, options?: { images?: ImageContent[] }): void {
		this.nextTurnQueue.push(createUserMessage(text, options?.images));
		void this.emitQueueUpdate();
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		if (this.phase === "idle") {
			await this.session.appendMessage(message);
		} else {
			this.pendingSessionWrites.push({ type: "message", message });
		}
	}

	async compact(
		customInstructions?: string,
	): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }> {
		if (this.phase !== "idle") throw new Error("compact() requires idle harness");
		this.phase = "compaction";
		const model = this.model;
		if (!model) throw new Error("No model set for compaction");
		const auth = await this.getApiKeyAndHeaders?.(model);
		if (!auth) throw new Error("No auth available for compaction");
		const branchEntries = await this.session.getBranch();
		const preparation = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
		if (!preparation) throw new Error("Nothing to compact");
		const hookResult = await this.emitHook({
			type: "session_before_compact",
			preparation,
			branchEntries,
			customInstructions,
			signal: new AbortController().signal,
		});
		if (hookResult?.cancel) {
			this.phase = "idle";
			throw new Error("Compaction cancelled");
		}
		const provided = hookResult?.compaction;
		const result =
			provided ??
			(await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				customInstructions,
				undefined,
				this.thinkingLevel,
			));
		const entryId = await this.session.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			provided !== undefined,
		);
		const entry = await this.session.getEntry(entryId);
		if (entry?.type === "compaction") {
			await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
		}
		this.phase = "idle";
		return result;
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		if (this.phase !== "idle") throw new Error("navigateTree() requires idle harness");
		this.phase = "branch_summary";
		const oldLeafId = await this.session.getLeafId();
		if (oldLeafId === targetId) {
			this.phase = "idle";
			return { cancelled: false };
		}
		const targetEntry = await this.session.getEntry(targetId);
		if (!targetEntry) throw new Error(`Entry ${targetId} not found`);
		const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
		const preparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize: entries,
			userWantsSummary: options?.summarize ?? false,
			customInstructions: options?.customInstructions,
			replaceInstructions: options?.replaceInstructions,
			label: options?.label,
		};
		const signal = new AbortController().signal;
		const hookResult = await this.emitHook({
			type: "session_before_tree",
			preparation,
			signal,
		});
		if (hookResult?.cancel) {
			this.phase = "idle";
			return { cancelled: true };
		}
		let summaryEntry: any | undefined;
		let summaryText: string | undefined = hookResult?.summary?.summary;
		let summaryDetails: unknown = hookResult?.summary?.details;
		if (!summaryText && options?.summarize && entries.length > 0) {
			const model = this.model;
			if (!model) throw new Error("No model set for branch summary");
			const auth = await this.getApiKeyAndHeaders?.(model);
			if (!auth) throw new Error("No auth available for branch summary");
			const branchSummary = await generateBranchSummary(entries, {
				model,
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: new AbortController().signal,
				customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
				replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
			});
			if (branchSummary.aborted) {
				this.phase = "idle";
				return { cancelled: true };
			}
			if (branchSummary.error) throw new Error(branchSummary.error);
			summaryText = branchSummary.summary;
			summaryDetails = {
				readFiles: branchSummary.readFiles ?? [],
				modifiedFiles: branchSummary.modifiedFiles ?? [],
			};
		}
		let editorText: string | undefined;
		let newLeafId: string | null;
		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			newLeafId = targetEntry.parentId;
			const content = targetEntry.message.content;
			editorText =
				typeof content === "string"
					? content
					: content
							.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else if (targetEntry.type === "custom_message") {
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			newLeafId = targetId;
		}
		const summaryId = await this.session.moveTo(
			newLeafId,
			summaryText
				? {
						summary: summaryText,
						details: summaryDetails,
						fromHook: hookResult?.summary !== undefined,
					}
				: undefined,
		);
		if (summaryId) {
			summaryEntry = await this.session.getEntry(summaryId);
		}
		await this.emitOwn({
			type: "session_tree",
			newLeafId: await this.session.getLeafId(),
			oldLeafId,
			summaryEntry,
			fromHook: hookResult?.summary !== undefined,
		});
		this.phase = "idle";
		return { cancelled: false, editorText, summaryEntry };
	}

	async setModel(model: Model<any>): Promise<void> {
		const previousModel = this.model;
		this.model = model;
		if (this.phase === "idle") {
			this.agent.state.model = model;
			await this.session.appendModelChange(model.provider, model.id);
		} else {
			this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
		}
		await this.emitOwn({ type: "model_select", model, previousModel, source: "set" });
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const previousLevel = this.thinkingLevel;
		this.thinkingLevel = level;
		if (this.phase === "idle") {
			this.agent.state.thinkingLevel = level;
			await this.session.appendThinkingLevelChange(level);
		} else {
			this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
		}
		await this.emitOwn({ type: "thinking_level_select", level, previousLevel });
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		this.validateToolNames(toolNames);
		this.activeToolNames = [...toolNames];
		if (this.phase === "idle") {
			this.agent.state.tools = this.activeToolNames.map((name) => this.tools.get(name)!);
		}
	}

	get steeringMode(): QueueMode {
		return this.agent.steeringMode;
	}

	set steeringMode(mode: QueueMode) {
		this.agent.steeringMode = mode;
	}

	get followUpMode(): QueueMode {
		return this.agent.followUpMode;
	}

	set followUpMode(mode: QueueMode) {
		this.agent.followUpMode = mode;
	}

	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		const previousResources = this.getResources();
		this.resources = {
			skills: resources.skills?.slice(),
			promptTemplates: resources.promptTemplates?.slice(),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	setStreamOptions(streamOptions: AgentHarnessStreamOptions): void {
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		this.tools = new Map(tools.map((tool) => [tool.name, tool]));
		if (activeToolNames) {
			this.validateToolNames(activeToolNames);
			this.activeToolNames = [...activeToolNames];
		} else {
			this.validateToolNames(this.activeToolNames);
		}
		if (this.phase === "idle") {
			this.agent.state.tools = this.activeToolNames.map((name) => this.tools.get(name)!);
		}
	}

	async abort(): Promise<AbortResult> {
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		this.agent.clearAllQueues();
		await this.emitQueueUpdate();
		this.agent.abort();
		await this.agent.waitForIdle();
		await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		return { clearedSteer, clearedFollowUp };
	}

	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
	}

	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		let handlers = this.hooks.get(type);
		if (!handlers) {
			handlers = new Set();
			this.hooks.set(type, handlers);
		}
		handlers.add(handler as any);
		return () => handlers!.delete(handler as any);
	}
}
