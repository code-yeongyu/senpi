import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as piAi from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	JsonObject,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { AcpRpcError, type AcpPromptUsage } from "./acp-client.ts";
import type { BridgeCallResult, BridgeTool } from "./bridge-server.ts";
import { BRIDGE_TOOL_PREFIX } from "./constants.ts";
import { resolveAgyModelTarget } from "./models.ts";
import { renderBootstrapBlocks, renderLateToolResultBlocks, renderUserTurn, renderUserTurnBlocks } from "./prompt.ts";
import {
	type AgySession,
	type AgySessionBinding,
	armHoldTimer,
	assistantMessageDigest,
	cancelTurn,
	clearHoldTimer,
	closeSession,
	configureSessionModel,
	decideContinuity,
	detachParkedTools,
	findContinuationDeltaStart,
	getBinding,
	getSession,
	messageAnchorDigest,
	messagePrefixDigest,
	prepareAgySession,
	refreshSessionConfig,
	rememberSessionBinding,
	sendPrompt,
	startAgySession,
} from "./session.ts";
import { type AntigravityAcpSettings, DEFAULT_ANTIGRAVITY_AUTH_METHOD } from "./settings.ts";

/**
 * agy keeps a few harmless internal bookkeeping/resource tools even when `tools: []` and
 * `excludeDefaultComponents: true` are configured. Every other non-bridge builtin is refused.
 */
const AGY_TOOLS_WITHOUT_HOST_EFFECT: ReadonlySet<string> = new Set([
	"call_mcp_tool",
	"manage_task",
	"finish",
	"list_resources",
	"read_resource",
]);

const AUTH_GUIDANCE =
	'Antigravity CLI authentication failed. Configure GEMINI_API_KEY (authMethod: "gemini-api-key") or GOOGLE_CLOUD_PROJECT (authMethod: "agent-platform"), or verify your local agy CLI configuration, then retry.';

export const MAX_BRIDGE_TOOLS_BYTES = 28_000;
const DEFAULT_TOOL_BATCH_COALESCE_MS = 15;

type CompactionPass = {
	readonly topDescriptionMax: number;
	readonly nestedDescriptionMax: number;
	readonly dropNestedDescriptions: boolean;
};

const COMPACTION_PASSES: readonly CompactionPass[] = [
	{ topDescriptionMax: 240, nestedDescriptionMax: 160, dropNestedDescriptions: false },
	{ topDescriptionMax: 120, nestedDescriptionMax: 60, dropNestedDescriptions: false },
	{ topDescriptionMax: 80, nestedDescriptionMax: 0, dropNestedDescriptions: true },
];

// agy streams quota retry notices as plain text/thinking lines before retrying itself.
const RETRY_NOTICE = /(?:^|\n)[^\S\n]*(?:⚠\uFE0F?[^\S\n]*)?API error \(attempt \d+\):[^\S\n]*([^\n]+)/;
const QUOTA_EXHAUSTED = /\bRESOURCE_EXHAUSTED\b|\bcode 429\b/;
const NOTICE_MARK = /^[^\S\n]*(?:⚠\uFE0F?[^\S\n]*)?/;
const NOTICE_HEAD = "API error (attempt ";
const NOTICE_ATTEMPT = /^\d*$|^\d+\)(?::.*)?$/;

export type AntigravityBinding = AgySessionBinding;

export type AntigravityStreamDeps = {
	readonly getCwd?: () => string;
	readonly resolveExecutable: (settings: AntigravityAcpSettings) => string;
	readonly loadSettings: (cwd: string) => AntigravityAcpSettings;
	readonly agentDir: string;
	readonly acpArgs?: readonly string[];
	readonly holdLimitMs?: number;
	readonly cancelTimeoutMs?: number;
	readonly toolBatchCoalesceMs?: number;
	readonly discoveredTools?: (key: string) => readonly Tool[];
	readonly onBinding?: (key: string, binding: AntigravityBinding) => void;
};

type ExtractedContext = {
	readonly systemPrompt: string;
	readonly messages: readonly Message[];
	readonly tools: readonly Tool[];
};

function extractContext(input: TranscriptContext | Context): ExtractedContext {
	const rawMessages = input.messages ?? [];
	const hasSystem = rawMessages.some((m) => m.role === "system");
	if (
		hasSystem &&
		typeof piAi.collapseSystemMessages === "function" &&
		typeof piAi.getInitialSystemMessage === "function" &&
		typeof piAi.getCurrentSystemPrompt === "function" &&
		typeof piAi.getCurrentTools === "function"
	) {
		const transcript = piAi.collapseSystemMessages(input as TranscriptContext);
		const head = piAi.getInitialSystemMessage(transcript.messages);
		const messages = transcript.messages.filter((m) => m.role !== "system");
		const systemPrompt = head ? piAi.getCurrentSystemPrompt(transcript.messages) : "";
		let tools = head ? piAi.getCurrentTools(transcript.messages) : [];
		if (input.activeToolNames !== undefined) {
			const allowed = new Set(input.activeToolNames);
			tools = tools.filter((t) => allowed.has(t.name));
		}
		return { systemPrompt, messages, tools };
	}
	const legacy = input as Context;
	let tools = legacy.tools ?? [];
	if (input.activeToolNames !== undefined) {
		const allowed = new Set(input.activeToolNames);
		tools = tools.filter((t) => allowed.has(t.name));
	}
	return {
		systemPrompt: legacy.systemPrompt ?? "",
		messages: rawMessages,
		tools,
	};
}

export function createAntigravityStream(
	deps: AntigravityStreamDeps,
): (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = piAi.createAssistantMessageEventStream();
		void runStream(stream, model, context, options, deps);
		return stream;
	};
}

type StreamState = {
	readonly stream: AssistantMessageEventStream;
	readonly output: AssistantMessage;
	readonly model: Model<Api>;
	openTextIndex: number | undefined;
	openThinkingIndex: number | undefined;
	heldNotice: { kind: "text" | "thinking"; text: string } | undefined;
};

async function runStream(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	rawContext: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	deps: AntigravityStreamDeps,
): Promise<void> {
	const initialTarget = resolveAgyModelTarget(model.id, options?.reasoning);
	const output = emptyOutput(model, initialTarget.agyModelId, initialTarget.thinkingTier);
	const state: StreamState = {
		stream,
		output,
		model,
		openTextIndex: undefined,
		openThinkingIndex: undefined,
		heldNotice: undefined,
	};
	let session: AgySession | undefined;
	let ephemeral = false;
	let completed = false;
	try {
		if (options?.signal?.aborted) throw abortError(options.signal);
		const projectCwd = options?.cwd ?? deps.getCwd?.() ?? process.cwd();
		const settings = deps.loadSettings(projectCwd);
		const executable = deps.resolveExecutable(settings);
		const extracted = extractContext(rawContext);
		const requestedSessionId = options?.sessionId;
		ephemeral = options?.streamKind !== "main" || requestedSessionId === undefined || options.toolChoice === "none";

		const key = ephemeral ? `aux-${randomUUID()}` : requestedSessionId;
		if (key === undefined) throw new Error("Antigravity main streams require a session id.");
		const tools = ephemeral ? [] : bridgeTools(extracted.tools, deps.discoveredTools?.(key) ?? []);
		const prepared = await prepareAgySession({
			key,
			agentDir: deps.agentDir,
			systemPrompt: extracted.systemPrompt,
			projectCwd,
			tools,
		});

		const existing = getSession(key);
		const binding = getBinding(key);
		const syncedCount = existing?.syncedCount ?? binding?.syncedCount ?? 0;
		const pendingToolResultStart = findPendingToolResultStart(extracted.messages, existing, syncedCount);
		const beginsWithPendingToolResult = pendingToolResultStart !== undefined;
		const trailingAfterSynced = extracted.messages.slice(Math.min(syncedCount, extracted.messages.length));

		if (
			existing !== undefined &&
			(existing.queue.size > 0 || existing.queue.hasDetached()) &&
			!beginsWithPendingToolResult &&
			trailingAfterSynced.some((message) => message.role === "user")
		) {
			closeSession(key, "interrupted by the user", { keepConversation: true });
		}

		const live = getSession(key);
		const currentBinding = getBinding(key);
		const deltaStart = ephemeral ? undefined : findContinuationDeltaStart(extracted.messages, currentBinding);
		let decision = ephemeral
			? "bootstrap"
			: decideContinuity({
					live: live !== undefined && !live.exited,
					conversationId: live?.conversationId ?? currentBinding?.conversationId,
					prefixMatches: deltaStart !== undefined,
					resumeMode: settings.resumeMode ?? "auto",
					hasPendingCalls: live !== undefined && !live.exited && (live.queue.size > 0 || live.queue.hasDetached()),
					beginsWithPendingToolResult,
				});

		let expectedPromptSeq: number;

		if (decision === "resolve-tools") {
			session = live;
			if (session === undefined) throw new Error("Antigravity continuity selected a missing resident session.");
			clearHoldTimer(session);
			const toolsChanged = session.toolsHash !== prepared.workspace.toolsHash;
			const systemPromptChanged = session.systemPromptHash !== prepared.workspace.systemPromptHash;
			if (toolsChanged && session.queue.size > 0) {
				await detachParkedTools(
					session,
					"Host tool list changed; refreshing session config and delivering tool results in the follow-up prompt.",
				);
			}
			session.tools = tools;
			session.lastUsedAt = Date.now();
			session.turnActive = true;

			if (pendingToolResultStart === undefined) {
				throw new Error("Antigravity continuity selected parked resolution without a pending tool result.");
			}
			const resolution = resolvePendingTools(session, extracted.messages.slice(pendingToolResultStart));
			if (resolution.mode === "parked") {
				expectedPromptSeq = session.promptSeq;
				stream.push({ type: "start", partial: output });
			} else {
				const refreshed = await refreshSessionConfig(session, prepared.workspace, tools, options?.signal);
				if (!refreshed) {
					closeSession(key, "config_refresh_failed", { keepConversation: true });
					session = await startAgySession({
						prepared,
						executable,
						acpArgs: deps.acpArgs,
						modelId: initialTarget.agyModelId,
						conversationId: currentBinding?.conversationId,
						tools,
						authMethod: settings.authMethod ?? DEFAULT_ANTIGRAVITY_AUTH_METHOD,
						holdLimitMs: deps.holdLimitMs,
						cancelTimeoutMs: deps.cancelTimeoutMs,
						signal: options?.signal,
					});
					session.turnActive = true;
				}
				const target = await configureSessionModel(session, model.id, options?.reasoning, options?.signal);
				output.responseModel = target.agyModelId;
				if (target.thinkingTier !== undefined) output.providerThinkingLevel = target.thinkingTier;
				else delete output.providerThinkingLevel;
				stream.push({ type: "start", partial: output });
				expectedPromptSeq = sendPrompt(
					session,
					renderLateToolResultBlocks(resolution.results, resolution.steering, {
						reason: toolsChanged || systemPromptChanged ? "config-refresh" : "timeout",
					}),
				);
			}
		} else {
			if (decision === "delta" && live !== undefined) {
				const refreshed = await refreshSessionConfig(live, prepared.workspace, tools, options?.signal);
				if (refreshed) {
					session = live;
				} else {
					closeSession(key, "config_refresh_failed", { keepConversation: true });
					decision =
						currentBinding?.conversationId !== undefined && (settings.resumeMode ?? "auto") === "auto"
							? "reattach"
							: "bootstrap";
				}
			}

			if (session === undefined) {
				if (live !== undefined) closeSession(key, "continuity_restart", { keepConversation: true });
				const conversationId = decision === "reattach" ? currentBinding?.conversationId : undefined;
				session = await startAgySession({
					prepared,
					executable,
					acpArgs: deps.acpArgs,
					modelId: initialTarget.agyModelId,
					...(conversationId === undefined ? {} : { conversationId }),
					tools,
					authMethod: settings.authMethod,
					holdLimitMs: deps.holdLimitMs,
					cancelTimeoutMs: deps.cancelTimeoutMs,
					signal: options?.signal,
				});
				if (decision === "reattach" && !session.resumedFromConversation) {
					decision = "bootstrap";
				}
				if (decision === "bootstrap") {
					session.syncedCount = 0;
					session.prefixDigest = messagePrefixDigest([]);
					session.lastAssistantDigest = undefined;
					session.lastInputDigest = undefined;
				}
			}

			session.turnActive = true;
			const target = await configureSessionModel(session, model.id, options?.reasoning, options?.signal);
			output.responseModel = target.agyModelId;
			if (target.thinkingTier !== undefined) output.providerThinkingLevel = target.thinkingTier;
			else delete output.providerThinkingLevel;

			stream.push({ type: "start", partial: output });
			const blocks =
				decision === "bootstrap" || deltaStart === undefined
					? renderBootstrapBlocks(...splitBootstrapMessages(extracted.messages))
					: renderUserTurnBlocks(extracted.messages.slice(deltaStart));
			expectedPromptSeq = sendPrompt(session, blocks);
		}

		await pumpTurn(
			state,
			session,
			expectedPromptSeq,
			options?.signal,
			deps.toolBatchCoalesceMs ?? DEFAULT_TOOL_BATCH_COALESCE_MS,
		);

		if (
			!ephemeral &&
			(output.stopReason === "stop" || output.stopReason === "length" || output.stopReason === "toolUse")
		) {
			session.syncedCount = extracted.messages.length + 1;
			session.prefixDigest = messagePrefixDigest(extracted.messages);
			session.lastAssistantDigest = assistantMessageDigest(output);
			session.lastInputDigest = messageAnchorDigest(extracted.messages[extracted.messages.length - 1]);
			session.lastUsedAt = Date.now();
			const bindingResult = rememberSessionBinding(session);
			if (bindingResult !== undefined) deps.onBinding?.(session.key, bindingResult);
		}
		completed = true;
	} catch (error) {
		flushHeldNotice(state);
		closeOpenBlocks(state);
		const aborted = options?.signal?.aborted === true || isAbortError(error);
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = aborted ? "aborted" : classifyError(error);
		if (session !== undefined) {
			if (aborted) {
				const cancelledCleanly = await cancelTurn(session);
				if (!cancelledCleanly || session.exited) {
					closeSession(session.key, "aborted", { keepConversation: true });
				}
			} else {
				const keepConversation = output.errorMessage.includes("429 rate limit");
				if (keepConversation) {
					await cancelTurn(session);
				}
				closeSession(session.key, "turn_error", { keepConversation });
			}
		}
		stream.push({ type: "error", reason: output.stopReason, error: output });
	} finally {
		if (session !== undefined) session.turnActive = false;
		if (ephemeral && session !== undefined) {
			closeSession(session.key, completed ? "one_shot_complete" : "one_shot_failed", {
				keepConversation: false,
			});
		}
		stream.end();
	}
}

export function bridgeTools(active: readonly Tool[], discovered: readonly Tool[]): BridgeTool[] {
	const tools = new Map<string, Tool>();
	for (const tool of active) tools.set(tool.name, tool);
	for (const tool of discovered) {
		if (!tools.has(tool.name)) tools.set(tool.name, tool);
	}
	const sorted = [...tools.values()].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	let compacted: BridgeTool[] = [];
	for (const pass of COMPACTION_PASSES) {
		compacted = sorted.map((tool) => compactBridgeTool(tool, pass));
		if (Buffer.byteLength(JSON.stringify(compacted), "utf8") <= MAX_BRIDGE_TOOLS_BYTES) {
			return compacted;
		}
	}
	return compacted;
}

function compactBridgeTool(tool: Tool, pass: CompactionPass): BridgeTool {
	const rawSchema = isPlainRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} };
	return {
		name: tool.name,
		description: truncateDescription(tool.description ?? "", pass.topDescriptionMax),
		inputSchema: compactToolSchema(rawSchema, pass, true),
	};
}

function compactToolSchema(
	schema: Record<string, unknown>,
	pass: CompactionPass,
	isRoot: boolean,
): Record<string, unknown> {
	const collapsedConst = tryCollapseConstUnion(schema, pass, isRoot);
	if (collapsedConst !== undefined) return collapsedConst;

	const stripRootUnion =
		isRoot &&
		schema.type === "object" &&
		isPlainRecord(schema.properties) &&
		Object.keys(schema.properties).length > 0;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (stripRootUnion && (key === "anyOf" || key === "oneOf")) continue;
		if (key === "description" && typeof value === "string") {
			if (!isRoot && pass.dropNestedDescriptions) continue;
			out[key] = truncateDescription(value, isRoot ? pass.topDescriptionMax : pass.nestedDescriptionMax);
			continue;
		}
		if (key === "properties" && isPlainRecord(value)) {
			const props: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value)) {
				props[propName] = compactSchemaValue(propSchema, pass);
			}
			out[key] = props;
			continue;
		}
		if ((key === "$defs" || key === "definitions") && isPlainRecord(value)) {
			const defs: Record<string, unknown> = {};
			for (const [defName, defSchema] of Object.entries(value)) {
				defs[defName] = compactSchemaValue(defSchema, pass);
			}
			out[key] = defs;
			continue;
		}
		out[key] = compactSchemaValue(value, pass);
	}
	return out;
}

function compactSchemaValue(value: unknown, pass: CompactionPass): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => compactSchemaValue(item, pass));
	}
	if (isPlainRecord(value)) {
		return compactToolSchema(value, pass, false);
	}
	return value;
}

function tryCollapseConstUnion(
	schema: Record<string, unknown>,
	pass: CompactionPass,
	isRoot: boolean,
): Record<string, unknown> | undefined {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (branches === undefined || branches.length === 0) return undefined;
	if (
		isRoot &&
		schema.type === "object" &&
		isPlainRecord(schema.properties) &&
		Object.keys(schema.properties).length > 0
	) {
		return undefined;
	}

	const literals: Array<string | number | boolean> = [];
	let literalType: "string" | "number" | "boolean" | undefined;
	for (const branch of branches) {
		if (!isPlainRecord(branch) || !Object.hasOwn(branch, "const")) return undefined;
		for (const branchKey of Object.keys(branch)) {
			if (branchKey !== "const" && branchKey !== "type" && branchKey !== "description" && branchKey !== "title") {
				return undefined;
			}
		}
		const val = branch.const;
		if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") return undefined;
		if (typeof val === "number" && !Number.isFinite(val)) return undefined;
		const valType: "string" | "number" | "boolean" =
			typeof val === "string" ? "string" : typeof val === "number" ? "number" : "boolean";
		if (literalType === undefined) literalType = valType;
		else if (literalType !== valType) return undefined;
		literals.push(val);
	}

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "anyOf" || key === "oneOf") continue;
		if (key === "description" && typeof value === "string") {
			if (!isRoot && pass.dropNestedDescriptions) continue;
			out[key] = truncateDescription(value, isRoot ? pass.topDescriptionMax : pass.nestedDescriptionMax);
			continue;
		}
		out[key] = compactSchemaValue(value, pass);
	}
	if (out.type === undefined && literalType !== undefined) {
		out.type = literalType;
	}
	out.enum = literals;
	return out;
}

function truncateDescription(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (maxChars <= 0) return "";
	if (collapsed.length <= maxChars) return collapsed;
	if (maxChars <= 3) return collapsed.slice(0, maxChars);
	return `${collapsed.slice(0, maxChars - 3)}...`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitBootstrapMessages(messages: readonly Message[]): [readonly Message[], readonly Message[]] {
	let lastUser = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			lastUser = index;
			break;
		}
	}
	if (lastUser < 0) return [[], messages];
	let turnStart = lastUser;
	while (turnStart > 0 && messages[turnStart - 1]?.role === "user") {
		turnStart -= 1;
	}
	return [messages.slice(0, turnStart), messages.slice(turnStart)];
}

function findPendingToolResultStart(
	messages: readonly Message[],
	existing: AgySession | undefined,
	syncedCount: number,
): number | undefined {
	if (existing === undefined || (existing.queue.size === 0 && !existing.queue.hasDetached())) return undefined;
	const atSynced = messages[syncedCount];
	if (atSynced?.role === "toolResult" && existing.queue.hasCall(atSynced.toolCallId)) {
		return syncedCount;
	}
	const floor = Math.max(0, messages.length - 16);
	for (let index = messages.length - 1; index >= floor; index -= 1) {
		const message = messages[index];
		if (message?.role === "toolResult" && existing.queue.hasCall(message.toolCallId)) {
			let start = index;
			while (
				start > 0 &&
				messages[start - 1]?.role === "toolResult" &&
				existing.queue.hasCall((messages[start - 1] as ToolResultMessage).toolCallId)
			) {
				start -= 1;
			}
			return start;
		}
	}
	return undefined;
}

type ToolResolution =
	| { readonly mode: "parked" }
	| {
			readonly mode: "detached";
			readonly results: readonly ToolResultMessage[];
			readonly steering: readonly Message[];
	  };

function resolvePendingTools(session: AgySession, newMessages: readonly Message[]): ToolResolution {
	const results: ToolResultMessage[] = [];
	let index = 0;
	while (index < newMessages.length) {
		const message = newMessages[index];
		if (message?.role !== "toolResult" || !session.queue.hasCall(message.toolCallId)) break;
		results.push(message);
		index += 1;
	}
	if (results.length === 0) throw new Error("Antigravity has no matching held tool calls to resolve.");
	const steering = newMessages.slice(index);

	const allDetached = results.every((r) => session.queue.isDetached(r.toolCallId));
	if (allDetached) {
		for (const result of results) session.queue.consumeDetached(result.toolCallId);
		return { mode: "detached", results, steering };
	}

	const anyDetached = results.some((r) => session.queue.isDetached(r.toolCallId));
	if (anyDetached) {
		for (const result of results) {
			if (session.queue.isDetached(result.toolCallId)) {
				session.queue.consumeDetached(result.toolCallId);
			} else {
				session.queue.resolve(result.toolCallId, bridgeResult(result));
			}
		}
		return { mode: "detached", results, steering };
	}

	for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
		const message = results[resultIndex];
		if (message === undefined) continue;
		const result = bridgeResult(message);
		if (resultIndex === results.length - 1 && steering.length > 0) {
			result.content.push({
				type: "text",
				text: `[message from the user while the tool ran]\n${renderUserTurn(steering)}`,
			});
		}
		if (!session.queue.resolve(message.toolCallId, result)) {
			throw new Error(`Antigravity tool call ${message.toolCallId} is no longer pending.`);
		}
	}
	return { mode: "parked" };
}

function bridgeResult(message: ToolResultMessage): BridgeCallResult {
	const content: BridgeCallResult["content"] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			content.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return { content, isError: message.isError };
}

async function pumpTurn(
	state: StreamState,
	session: AgySession,
	expectedPromptSeq: number,
	signal: AbortSignal | undefined,
	coalesceMs: number,
): Promise<void> {
	while (true) {
		if (signal?.aborted) throw abortError(signal);
		if (session.queue.hasUnclaimed()) {
			if (coalesceMs > 0) {
				await waitCoalesceWindow(coalesceMs, signal);
			}
			emitToolCalls(state, session);
			return;
		}
		const event = session.events.shift();
		if (event === undefined) {
			const readinessController = new AbortController();
			const readinessSignal = combinedSignal(signal, readinessController.signal);
			try {
				await Promise.race([
					session.queue.whenUnclaimed(readinessSignal),
					session.events.whenAvailable(readinessSignal),
				]);
			} finally {
				readinessController.abort();
			}
			continue;
		}

		if (event.type === "exit") {
			throw new Error(`agy acp exited unexpectedly (code ${event.code ?? "null"}): ${session.client.stderrTail}`);
		}
		if (event.promptSeq !== expectedPromptSeq) {
			continue;
		}
		if (event.type === "promptError") {
			throw event.error;
		}
		if (event.type === "promptDone") {
			flushHeldNotice(state);
			closeOpenBlocks(state);
			const stopReason = event.result.stopReason;
			if (stopReason === "cancelled") {
				throw new Error("Antigravity ACP cancelled the request");
			}
			applyUsage(state, event.result.usage);
			const mappedReason = stopReason === "max_tokens" ? "length" : "stop";
			state.output.stopReason = mappedReason;
			state.stream.push({ type: "done", reason: mappedReason, message: state.output });
			return;
		}
		if (event.type === "update") {
			const update = event.notification.update;
			if (!update) continue;
			const kind = update.sessionUpdate;
			if (
				kind === "agent_message_chunk" &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				streamNoticeAware(state, "text", update.content.text);
			} else if (
				kind === "agent_thought_chunk" &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				streamNoticeAware(state, "thinking", update.content.text);
			} else if (kind === "tool_call") {
				const toolName = typeof update.name === "string" ? update.name : undefined;
				const status = typeof update.status === "string" ? update.status : undefined;
				if (
					toolName !== undefined &&
					status !== "failed" &&
					status !== "error" &&
					status !== "cancelled" &&
					!toolName.startsWith(BRIDGE_TOOL_PREFIX) &&
					!AGY_TOOLS_WITHOUT_HOST_EFFECT.has(toolName)
				) {
					closeSession(session.key, "builtin_tool_refused", { keepConversation: false });
					throw new Error(`agy ran its builtin tool ${toolName}; the antigravity-acp lane refuses builtin tools.`);
				}
			}
		}
	}
}

function streamNoticeAware(state: StreamState, kind: "text" | "thinking", chunk: string): void {
	if (!chunk) return;
	if (state.heldNotice !== undefined && state.heldNotice.kind !== kind) {
		flushHeldNotice(state);
	}
	const text = (state.heldNotice?.text ?? "") + chunk;
	state.heldNotice = undefined;

	const exhausted = quotaRetryNotice(text);
	if (exhausted !== undefined) {
		throw new Error(`${exhausted} (429 rate limit)`);
	}

	const lineStart = text.lastIndexOf("\n") + 1;
	const tail = text.slice(lineStart);
	const visible = mayBecomeRetryNotice(tail) ? text.slice(0, lineStart) : text;
	if (visible.length < text.length) {
		state.heldNotice = { kind, text: text.slice(visible.length) };
	}
	if (visible.length > 0) {
		if (kind === "text") pushText(state, visible);
		else pushThinking(state, visible);
	}
}

function flushHeldNotice(state: StreamState): void {
	const held = state.heldNotice;
	state.heldNotice = undefined;
	if (held === undefined || held.text.length === 0) return;
	if (held.kind === "text") pushText(state, held.text);
	else pushThinking(state, held.text);
}

function quotaRetryNotice(text: string): string | undefined {
	const detail = RETRY_NOTICE.exec(text)?.[1]?.trim();
	return detail && QUOTA_EXHAUSTED.test(detail) ? detail : undefined;
}

function mayBecomeRetryNotice(line: string): boolean {
	if (line.length === 0) return false;
	const rest = line.replace(NOTICE_MARK, "");
	if (rest.length < NOTICE_HEAD.length) return NOTICE_HEAD.startsWith(rest);
	return rest.startsWith(NOTICE_HEAD) && NOTICE_ATTEMPT.test(rest.slice(NOTICE_HEAD.length));
}

function emitToolCalls(state: StreamState, session: AgySession): void {
	flushHeldNotice(state);
	let call = session.queue.takeUnclaimed();
	while (call !== undefined) {
		emitToolCall(state, call);
		call = session.queue.takeUnclaimed();
	}
	armHoldTimer(session);
	finishWithTools(state);
}

function emitToolCall(
	state: StreamState,
	call: { readonly toolCallId: string; readonly name: string; readonly args: Record<string, unknown> },
): void {
	closeOpenBlocks(state);
	const block: ToolCall = {
		type: "toolCall",
		id: call.toolCallId,
		name: call.name,
		arguments: call.args as JsonObject,
	};
	const contentIndex = state.output.content.length;
	state.output.content.push(block);
	state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
	state.stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(call.args),
		partial: state.output,
	});
	state.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: state.output });
}

function finishWithTools(state: StreamState): void {
	closeOpenBlocks(state);
	applyUsage(state, undefined);
	state.output.stopReason = "toolUse";
	state.stream.push({ type: "done", reason: "toolUse", message: state.output });
}

function pushText(state: StreamState, delta: string): void {
	if (!delta) return;
	closeThinking(state);
	if (state.openTextIndex === undefined) {
		state.openTextIndex = state.output.content.length;
		state.output.content.push({ type: "text", text: "" });
		state.stream.push({
			type: "text_start",
			contentIndex: state.openTextIndex,
			partial: state.output,
		});
	}
	const block = state.output.content[state.openTextIndex];
	if (block?.type !== "text") throw new Error("Antigravity text stream lost its open block.");
	block.text += delta;
	state.stream.push({
		type: "text_delta",
		contentIndex: state.openTextIndex,
		delta,
		partial: state.output,
	});
}

function pushThinking(state: StreamState, delta: string): void {
	if (!delta) return;
	closeText(state);
	if (state.openThinkingIndex === undefined) {
		state.openThinkingIndex = state.output.content.length;
		state.output.content.push({ type: "thinking", thinking: "" });
		state.stream.push({
			type: "thinking_start",
			contentIndex: state.openThinkingIndex,
			partial: state.output,
		});
	}
	const block = state.output.content[state.openThinkingIndex];
	if (block?.type !== "thinking") throw new Error("Antigravity thinking stream lost its open block.");
	block.thinking += delta;
	state.stream.push({
		type: "thinking_delta",
		contentIndex: state.openThinkingIndex,
		delta,
		partial: state.output,
	});
}

function closeText(state: StreamState): void {
	if (state.openTextIndex === undefined) return;
	const contentIndex = state.openTextIndex;
	const block = state.output.content[contentIndex];
	state.openTextIndex = undefined;
	if (block?.type !== "text") return;
	state.stream.push({
		type: "text_end",
		contentIndex,
		content: block.text,
		partial: state.output,
	});
}

function closeThinking(state: StreamState): void {
	if (state.openThinkingIndex === undefined) return;
	const contentIndex = state.openThinkingIndex;
	const block = state.output.content[contentIndex];
	state.openThinkingIndex = undefined;
	if (block?.type !== "thinking") return;
	state.stream.push({
		type: "thinking_end",
		contentIndex,
		content: block.thinking,
		partial: state.output,
	});
}

function closeOpenBlocks(state: StreamState): void {
	closeThinking(state);
	closeText(state);
}

function applyUsage(state: StreamState, usage: AcpPromptUsage | undefined): void {
	state.output.usage.input = usage?.inputTokens ?? 0;
	state.output.usage.output = usage?.outputTokens ?? 0;
	state.output.usage.cacheRead = usage?.cachedReadTokens ?? 0;
	state.output.usage.cacheWrite = usage?.cachedWriteTokens ?? 0;
	if (usage?.thoughtTokens != null) {
		state.output.usage.reasoning = usage.thoughtTokens;
	}
	state.output.usage.totalTokens =
		state.output.usage.input +
		state.output.usage.output +
		state.output.usage.cacheRead +
		state.output.usage.cacheWrite;
	state.output.usage.cost = piAi.calculateCost(state.model, state.output.usage);
}

function emptyOutput(
	model: Model<Api>,
	responseModel: string,
	providerThinkingLevel: string | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel,
		...(providerThinkingLevel !== undefined ? { providerThinkingLevel } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function classifyError(error: unknown): string {
	if (error instanceof AcpRpcError && error.code === -32000) {
		return AUTH_GUIDANCE;
	}
	const detail = error instanceof Error ? error.message : String(error);
	if (/not logged in|unauthenticated|authentication required|sign.?in/i.test(detail)) {
		return AUTH_GUIDANCE;
	}
	if (/RESOURCE_EXHAUSTED|quota|429|rate.?limit/i.test(detail)) {
		return detail.includes("(429 rate limit)") ? detail : `${detail} (429 rate limit)`;
	}
	return detail;
}

function combinedSignal(primary: AbortSignal | undefined, local: AbortSignal): AbortSignal {
	return primary === undefined ? local : AbortSignal.any([primary, local]);
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function waitCoalesceWindow(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) {
		return new Promise<void>((resolve) => {
			setTimeout(resolve, ms);
		});
	}
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
