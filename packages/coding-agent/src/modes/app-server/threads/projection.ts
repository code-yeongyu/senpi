import type { AssistantMessage, ProviderNativeContent, ToolCall } from "@earendil-works/pi-ai";
// allow: SIZE_OK - Todo 10 restricts the complete AgentEvent-to-wire-item protocol projector to this file.
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { formatProviderNativeBody, formatProviderNativeSummary } from "../../provider-native-rendering.ts";
import { codexErrorInfo, serializeCodexErrorInfo } from "../rpc/errors.ts";
import type { TurnLog, TurnStatus, WireItem } from "./turn-log.ts";

type ToolItemType = "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall";
type ActiveTextItem = { readonly id: string; text: string; completed: boolean };
type ActiveToolItem = {
	readonly id: string;
	readonly name: string;
	readonly itemType: ToolItemType;
	readonly args: unknown;
	output: string;
	completed: boolean;
};

export type ProjectedNotification = { readonly method: string; readonly params: unknown };
export type ProjectionTurnCompletion = { readonly status: TurnStatus; readonly errorMessage?: string };
export type ProjectionResult = {
	readonly notifications: readonly ProjectedNotification[];
	readonly turnCompletion?: ProjectionTurnCompletion;
};

export interface EventProjectorOptions {
	readonly threadId: string;
	readonly turnId: string;
	readonly turnLog?: TurnLog;
	readonly cwd?: string;
	readonly nowMs?: () => number;
}

const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MCP_TOOL_NAME_PATTERN = /^[^_]+__/;

export class EventProjector {
	private readonly options: EventProjectorOptions;
	private readonly textItems = new Map<number, ActiveTextItem>();
	private readonly reasoningItems = new Map<number, ActiveTextItem>();
	private readonly toolItems = new Map<string, ActiveToolItem>();
	private readonly completedItemIds = new Set<string>();
	private messageCounter = 0;
	private activeMessageId: string | undefined;
	private compactionItemId: string | undefined;

	constructor(options: EventProjectorOptions) {
		this.options = options;
	}

	project(event: AgentSessionEvent): ProjectionResult {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.activeMessageId = messageIdFromMessage(event.message) ?? this.nextMessageId();
				}
				return emptyResult();
			case "message_update":
				if (event.message.role !== "assistant") return emptyResult();
				this.activeMessageId = messageIdFromMessage(event.message) ?? this.activeMessageId ?? this.nextMessageId();
				return this.projectAssistantEvent(event.assistantMessageEvent);
			case "message_end":
				if (event.message.role !== "assistant") return emptyResult();
				this.activeMessageId = messageIdFromMessage(event.message) ?? this.activeMessageId ?? this.nextMessageId();
				return {
					notifications: [
						...this.completeDanglingText(event.message),
						...this.projectProviderNative(event.message),
					],
				};
			case "tool_execution_start":
				this.rememberTool(event.toolCallId, event.toolName, event.args);
				return emptyResult();
			case "tool_execution_update":
				return { notifications: this.projectToolUpdate(event.toolCallId, event.partialResult) };
			case "tool_execution_end":
				return { notifications: this.completeTool(event.toolCallId, event.isError, event.result) };
			case "compaction_start":
				return { notifications: this.startCompaction() };
			case "compaction_end":
				return { notifications: this.completeCompaction() };
			default:
				return emptyResult();
		}
	}

	private projectAssistantEvent(event: AssistantMessageEvent): ProjectionResult {
		switch (event.type) {
			case "start":
			case "toolcall_delta":
				return emptyResult();
			case "text_start":
				return { notifications: this.startText(event.contentIndex) };
			case "text_delta":
				return { notifications: this.deltaText(event.contentIndex, event.delta) };
			case "text_end":
				return { notifications: this.completeText(event.contentIndex, event.content) };
			case "thinking_start":
				return { notifications: this.startReasoning(event.contentIndex) };
			case "thinking_delta":
				return { notifications: this.deltaReasoning(event.contentIndex, event.delta) };
			case "thinking_end":
				return { notifications: this.completeReasoning(event.contentIndex, event.content) };
			case "toolcall_start":
				return emptyResult();
			case "toolcall_end":
				return { notifications: this.startTool(event.toolCall) };
			case "done":
				return { notifications: this.closeDanglingItems(), turnCompletion: { status: "completed" } };
			case "error":
				return {
					notifications: [this.errorNotification(event.error.errorMessage ?? "Agent turn failed")],
					turnCompletion: {
						status: event.reason === "aborted" ? "interrupted" : "failed",
						errorMessage: event.error.errorMessage,
					},
				};
			default:
				return assertNever(event);
		}
	}

	private nextMessageId(): string {
		this.messageCounter += 1;
		return `message-${this.messageCounter}`;
	}

	private itemId(contentIndex: number): string {
		return `${this.activeMessageId ?? this.nextMessageId()}:${contentIndex}`;
	}

	private startText(contentIndex: number): ProjectedNotification[] {
		const item: ActiveTextItem = { id: this.itemId(contentIndex), text: "", completed: false };
		this.textItems.set(contentIndex, item);
		return [this.started({ type: "agentMessage", id: item.id, text: "", phase: null, memoryCitation: null })];
	}

	private deltaText(contentIndex: number, delta: string): ProjectedNotification[] {
		const item = this.textItems.get(contentIndex) ?? this.createTextItem(contentIndex);
		item.text += delta;
		return [this.notification("item/agentMessage/delta", { itemId: item.id, delta })];
	}

	private completeText(contentIndex: number, text: string): ProjectedNotification[] {
		const item = this.textItems.get(contentIndex) ?? this.createTextItem(contentIndex);
		item.text = text;
		item.completed = true;
		return [
			this.completed({ type: "agentMessage", id: item.id, text: item.text, phase: null, memoryCitation: null }),
		];
	}

	private createTextItem(contentIndex: number): ActiveTextItem {
		const item: ActiveTextItem = { id: this.itemId(contentIndex), text: "", completed: false };
		this.textItems.set(contentIndex, item);
		return item;
	}

	private startReasoning(contentIndex: number): ProjectedNotification[] {
		const item: ActiveTextItem = { id: this.itemId(contentIndex), text: "", completed: false };
		this.reasoningItems.set(contentIndex, item);
		return [this.started({ type: "reasoning", id: item.id, summary: [], content: [] })];
	}

	private deltaReasoning(contentIndex: number, delta: string): ProjectedNotification[] {
		const item = this.reasoningItems.get(contentIndex) ?? this.createReasoningItem(contentIndex);
		item.text += delta;
		return [this.notification("item/reasoning/textDelta", { itemId: item.id, delta, contentIndex })];
	}

	private completeReasoning(contentIndex: number, text: string): ProjectedNotification[] {
		const item = this.reasoningItems.get(contentIndex) ?? this.createReasoningItem(contentIndex);
		item.text = text;
		item.completed = true;
		return [this.completed({ type: "reasoning", id: item.id, summary: [], content: [item.text] })];
	}

	private createReasoningItem(contentIndex: number): ActiveTextItem {
		const item: ActiveTextItem = { id: this.itemId(contentIndex), text: "", completed: false };
		this.reasoningItems.set(contentIndex, item);
		return item;
	}

	private startTool(toolCall: ToolCall): ProjectedNotification[] {
		const itemType = classifyTool(toolCall.name);
		const active: ActiveToolItem = {
			id: toolCall.id,
			name: toolCall.name,
			itemType,
			args: toolCall.arguments,
			output: "",
			completed: false,
		};
		this.toolItems.set(toolCall.id, active);
		return [this.started(this.toolWireItem(active, false))];
	}

	private rememberTool(toolCallId: string, toolName: string, args: unknown): void {
		if (this.toolItems.has(toolCallId)) return;
		this.toolItems.set(toolCallId, {
			id: toolCallId,
			name: toolName,
			itemType: classifyTool(toolName),
			args,
			output: "",
			completed: false,
		});
	}

	private projectToolUpdate(toolCallId: string, partialResult: unknown): ProjectedNotification[] {
		const tool = this.toolItems.get(toolCallId);
		if (tool?.itemType !== "commandExecution") return [];
		const delta = capUtf8(extractToolText(partialResult), MAX_TOOL_OUTPUT_BYTES - byteLength(tool.output));
		if (!delta) return [];
		tool.output += delta;
		return [this.notification("item/commandExecution/outputDelta", { itemId: tool.id, delta })];
	}

	private completeTool(toolCallId: string, isError: boolean, result: unknown): ProjectedNotification[] {
		const tool = this.toolItems.get(toolCallId);
		if (!tool || tool.completed) return [];
		tool.completed = true;
		const resultText = extractToolText(result);
		if (tool.itemType === "commandExecution" && !tool.output && resultText)
			tool.output = capUtf8(resultText, MAX_TOOL_OUTPUT_BYTES);
		return [this.completed(this.toolWireItem(tool, true, isError, result))];
	}

	private toolWireItem(tool: ActiveToolItem, completed: boolean, isError = false, result?: unknown): WireItem {
		const status = completed ? (isError ? "failed" : "completed") : "inProgress";
		switch (tool.itemType) {
			case "commandExecution":
				return commandExecutionItem(tool, status, this.options.cwd ?? process.cwd(), result);
			case "fileChange":
				return { type: "fileChange", id: tool.id, changes: [], status };
			case "mcpToolCall":
				return mcpToolCallItem(tool, status, result);
			case "dynamicToolCall":
				return dynamicToolCallItem(tool, status, result, isError);
			default:
				return assertNever(tool.itemType);
		}
	}

	private completeDanglingText(message: AssistantMessage): ProjectedNotification[] {
		return message.content.flatMap((content, contentIndex) => {
			if (content.type === "text" && !this.textItems.get(contentIndex)?.completed) {
				return this.completeText(contentIndex, content.text);
			}
			if (content.type === "thinking" && !this.reasoningItems.get(contentIndex)?.completed) {
				return this.completeReasoning(contentIndex, content.thinking);
			}
			return [];
		});
	}

	private projectProviderNative(message: AssistantMessage): ProjectedNotification[] {
		return message.content.flatMap((content, contentIndex) => {
			if (content.type !== "providerNative") return [];
			const id = `${this.activeMessageId ?? this.nextMessageId()}:providerNative:${contentIndex}`;
			const item = providerNativeItem(id, message, content);
			return [this.started(item), this.completed(item)];
		});
	}

	private closeDanglingItems(): ProjectedNotification[] {
		return [
			...unfinished(this.textItems).flatMap(([contentIndex, item]) => this.completeText(contentIndex, item.text)),
			...unfinished(this.reasoningItems).flatMap(([contentIndex, item]) =>
				this.completeReasoning(contentIndex, item.text),
			),
			...Array.from(this.toolItems.values()).flatMap((tool) =>
				tool.completed ? [] : this.completeTool(tool.id, false, undefined),
			),
		];
	}

	private startCompaction(): ProjectedNotification[] {
		this.compactionItemId = `context-compaction:${this.messageCounter + 1}`;
		return [this.started({ type: "contextCompaction", id: this.compactionItemId })];
	}

	private completeCompaction(): ProjectedNotification[] {
		const id = this.compactionItemId ?? `context-compaction:${this.messageCounter + 1}`;
		this.compactionItemId = undefined;
		return [this.completed({ type: "contextCompaction", id })];
	}

	private started(item: WireItem): ProjectedNotification {
		return this.notification("item/started", { item: buildWireItem(item), startedAtMs: this.nowMs() });
	}

	private completed(item: WireItem): ProjectedNotification {
		const wireItem = buildWireItem(item);
		if (!this.completedItemIds.has(String(wireItem.id))) {
			this.completedItemIds.add(String(wireItem.id));
			this.options.turnLog?.appendItem(this.options.threadId, this.options.turnId, wireItem);
		}
		return this.notification("item/completed", { item: wireItem, completedAtMs: this.nowMs() });
	}

	private errorNotification(message: string): ProjectedNotification {
		return this.notification("error", {
			error: { message, codexErrorInfo: serializeCodexErrorInfo(codexErrorInfo.other()), additionalDetails: null },
			willRetry: false,
		});
	}

	private notification(method: string, params: Record<string, unknown>): ProjectedNotification {
		return { method, params: { threadId: this.options.threadId, turnId: this.options.turnId, ...params } };
	}

	private nowMs(): number {
		return this.options.nowMs?.() ?? Date.now();
	}
}

type AssistantMessageEvent = Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

function emptyResult(): ProjectionResult {
	return { notifications: [] };
}

function messageIdFromMessage(message: AssistantMessage): string | undefined {
	return message.responseId;
}

function classifyTool(name: string): ToolItemType {
	if (name === "bash") return "commandExecution";
	if (name === "edit" || name === "write" || name === "apply_patch") return "fileChange";
	if (MCP_TOOL_NAME_PATTERN.test(name)) return "mcpToolCall";
	return "dynamicToolCall";
}

function commandExecutionItem(tool: ActiveToolItem, status: string, cwd: string, result: unknown): WireItem {
	return {
		type: "commandExecution",
		id: tool.id,
		command: commandFromArgs(tool.args),
		cwd,
		processId: null,
		source: "agent",
		status,
		commandActions: [],
		aggregatedOutput: tool.output || null,
		exitCode: status === "inProgress" ? null : exitCodeFromResult(result),
		durationMs: null,
	};
}

function mcpToolCallItem(tool: ActiveToolItem, status: string, result: unknown): WireItem {
	const [server, toolName] = splitMcpName(tool.name);
	return {
		type: "mcpToolCall",
		id: tool.id,
		server,
		tool: toolName,
		status,
		arguments: toJsonValue(tool.args),
		appContext: null,
		pluginId: null,
		result:
			status === "completed" ? { content: toolResultContent(result), structuredContent: null, _meta: null } : null,
		error: status === "failed" ? { message: extractToolText(result) || "Tool execution failed" } : null,
		durationMs: null,
	};
}

function dynamicToolCallItem(tool: ActiveToolItem, status: string, result: unknown, isError: boolean): WireItem {
	return {
		type: "dynamicToolCall",
		id: tool.id,
		namespace: null,
		tool: tool.name,
		arguments: toJsonValue(tool.args),
		status,
		contentItems: status === "inProgress" ? null : [{ type: "inputText", text: extractToolText(result) }],
		success: status === "inProgress" ? null : !isError,
		durationMs: null,
	};
}

function providerNativeItem(id: string, message: AssistantMessage, content: ProviderNativeContent): WireItem {
	const summary = formatProviderNativeSummary(message, content, true);
	const body = formatProviderNativeBody(content, true);
	return { type: "webSearch", id, query: body ? `${summary}\n${body}` : summary, action: null };
}

export function buildWireItem(item: WireItem): WireItem {
	return { ...item };
}

function commandFromArgs(args: unknown): string {
	if (!isRecord(args)) return "";
	const command = readString(args, "command") ?? readString(args, "cmd");
	return command ?? stringifyJson(toJsonValue(args));
}

function splitMcpName(name: string): readonly [string, string] {
	const marker = name.indexOf("__");
	return marker === -1 ? ["", name] : [name.slice(0, marker), name.slice(marker + 2)];
}

function extractToolText(result: unknown): string {
	if (!isRecord(result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return readString(result, "text") ?? "";
	return content
		.map((item) => (isRecord(item) && item.type === "text" ? (readString(item, "text") ?? "") : ""))
		.join("");
}

function exitCodeFromResult(result: unknown): number | null {
	if (!isRecord(result)) return null;
	const details = isRecord(result.details) ? result.details : undefined;
	const value = details ? (details.exitCode ?? details.code) : undefined;
	return typeof value === "number" ? value : null;
}

function toolResultContent(result: unknown): readonly unknown[] {
	if (!isRecord(result) || !Array.isArray(result.content)) return [];
	return result.content.map(toJsonValue);
}

function unfinished(items: Map<number, ActiveTextItem>): Array<[number, ActiveTextItem]> {
	return Array.from(items.entries()).filter((entry) => !entry[1].completed);
}

function capUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let used = 0;
	let result = "";
	for (const char of value) {
		const size = byteLength(char);
		if (used + size > maxBytes) break;
		used += size;
		result += char;
	}
	return result;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function toJsonValue(value: unknown): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (!isRecord(value)) return null;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
}

function stringifyJson(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

function assertNever(value: never): never {
	throw new Error(`Unhandled app-server projection variant: ${String(value)}`);
}
