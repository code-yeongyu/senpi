import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { MessageItemProjector } from "./projection-message-items.ts";
import { TurnDiffTracker } from "./projection-turn-diff.ts";
import {
	type AssistantMessageEvent,
	assertNeverProjection,
	type EventProjectorOptions,
	emptyResult,
	messageIdFromMessage,
	type ProjectedNotification,
	type ProjectionResult,
} from "./projection-types.ts";
import {
	type ActiveToolItem,
	buildWireItem,
	capCommandOutput,
	classifyTool,
	extractToolText,
	providerNativeItem,
	remainingCommandOutputBytes,
	toolWireProjection,
} from "./projection-wire-items.ts";
import type { WireItem } from "./turn-log.ts";

export class EventProjector {
	private readonly options: EventProjectorOptions;
	private readonly messageItems: MessageItemProjector;
	private readonly toolItems = new Map<string, ActiveToolItem>();
	private readonly completedItemIds = new Set<string>();
	private readonly turnDiff = new TurnDiffTracker();
	private messageCounter = 0;
	private activeMessageId: string | undefined;
	private compactionItemId: string | undefined;
	private finalized = false;

	constructor(options: EventProjectorOptions) {
		this.options = options;
		this.messageItems = new MessageItemProjector({
			itemId: (contentIndex) => this.itemId(contentIndex),
			started: (item) => this.started(item),
			completed: (item) => this.completed(item),
			notification: (method, params) => this.notification(method, params),
		});
	}

	project(event: AgentSessionEvent): ProjectionResult {
		if (this.finalized) return emptyResult();
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
						...this.messageItems.completeDanglingText(event.message),
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
				return { notifications: this.messageItems.startText(event.contentIndex) };
			case "text_delta":
				return { notifications: this.messageItems.deltaText(event.contentIndex, event.delta) };
			case "text_end":
				return { notifications: this.messageItems.completeText(event.contentIndex, event.content) };
			case "thinking_start":
				return { notifications: this.messageItems.startReasoning(event.contentIndex) };
			case "thinking_delta":
				return { notifications: this.messageItems.deltaReasoning(event.contentIndex, event.delta) };
			case "thinking_end":
				return { notifications: this.messageItems.completeReasoning(event.contentIndex, event.content) };
			case "toolcall_start":
				return emptyResult();
			case "toolcall_end":
				return { notifications: this.startTool(event.toolCall) };
			case "done":
				// A single turn can stream multiple assistant messages (tool calls run
				// between them), so message-level `done` must not force-complete tool
				// items that have not executed yet; `finalize()` closes those at turn end.
				return {
					notifications: this.messageItems.closeDanglingItems(),
					turnCompletion: { status: "completed" },
				};
			case "error":
				return {
					notifications: [],
					turnCompletion: {
						status: event.reason === "aborted" ? "interrupted" : "failed",
						errorMessage: event.error.errorMessage,
					},
				};
			default:
				return assertNeverProjection(event);
		}
	}

	/**
	 * Closes every dangling item at turn end. Idempotent: later calls (and any
	 * further projected events) become no-ops once the turn is finalized.
	 */
	finalize(): ProjectedNotification[] {
		if (this.finalized) return [];
		this.finalized = true;
		return this.closeDanglingItems();
	}

	private nextMessageId(): string {
		this.messageCounter += 1;
		return `message-${this.messageCounter}`;
	}

	private itemId(contentIndex: number): string {
		return `${this.activeMessageId ?? this.nextMessageId()}:${contentIndex}`;
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
		return [this.started(this.projectToolItem(active, false).item)];
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
		const delta = capCommandOutput(extractToolText(partialResult), remainingCommandOutputBytes(tool.output));
		if (!delta) return [];
		tool.output += delta;
		return [this.notification("item/commandExecution/outputDelta", { itemId: tool.id, delta })];
	}

	private completeTool(toolCallId: string, isError: boolean, result: unknown): ProjectedNotification[] {
		const tool = this.toolItems.get(toolCallId);
		if (!tool || tool.completed) return [];
		tool.completed = true;
		const resultText = extractToolText(result);
		if (tool.itemType === "commandExecution" && resultText) {
			tool.output = capCommandOutput(resultText);
		}
		const projection = this.projectToolItem(tool, true, isError, result);
		const cumulativeDiff = this.turnDiff.update(tool.id, projection.diff, this.toolItems.keys());
		return [
			this.completed(projection.item),
			...(cumulativeDiff === undefined ? [] : [this.notification("turn/diff/updated", { diff: cumulativeDiff })]),
		];
	}

	private projectToolItem(
		tool: ActiveToolItem,
		completed: boolean,
		isError = false,
		result?: unknown,
	): ReturnType<typeof toolWireProjection> {
		const status = completed ? (isError ? "failed" : "completed") : "inProgress";
		return toolWireProjection({
			tool,
			status,
			cwd: this.options.cwd ?? process.cwd(),
			result,
			isError,
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
			...this.messageItems.closeDanglingItems(),
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

	private notification(method: string, params: Record<string, unknown>): ProjectedNotification {
		return { method, params: { threadId: this.options.threadId, turnId: this.options.turnId, ...params } };
	}

	private nowMs(): number {
		return this.options.nowMs?.() ?? Date.now();
	}
}
