import type { Context } from "@earendil-works/pi-ai";
import { normalizeProviderId } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../../session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	ToolExecutionEndEvent,
} from "../../types.ts";
import { mapPiToolNameToSdk } from "./tools.ts";

export const TOOL_WATCH_CUSTOM_TYPE = "claude-sdk-oauth-tool-watch";
const PROVIDER_ID = "anthropic-subscription";
const MAX_TRACKED_TOOL_EXECUTIONS = 256;
const MAX_TRACKED_TOOL_CONTENT_CHARS = 4_000;
const MAX_LEDGER_TOOL_RESULTS = 4;
const MAX_LEDGER_TOOL_CONTENT_CHARS = 1_200;

export type TrackedToolExecution = {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type ToolWatchEntry = TrackedToolExecution & { type: "tool_execution_end" };
type ToolWatchState = { completedToolCalls: Map<string, TrackedToolExecution> };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const value = asRecord(block);
			if (value?.type === "text" && typeof value.text === "string") return value.text;
			if (value?.type === "image")
				return `[image:${typeof value.mimeType === "string" ? value.mimeType : "unknown"}]`;
			return typeof value?.type === "string" ? `[${value.type}]` : "";
		})
		.filter(Boolean)
		.join("\n");
}

function resultContent(result: unknown): string {
	const value = asRecord(result);
	const content = contentToText(value?.content);
	if (content) return truncate(content, MAX_TRACKED_TOOL_CONTENT_CHARS);
	try {
		return truncate(JSON.stringify(result), MAX_TRACKED_TOOL_CONTENT_CHARS);
	} catch {
		return truncate(String(result), MAX_TRACKED_TOOL_CONTENT_CHARS);
	}
}

function toolWatchEntry(data: unknown): TrackedToolExecution | undefined {
	const value = asRecord(data);
	if (
		value?.type !== "tool_execution_end" ||
		typeof value.toolCallId !== "string" ||
		typeof value.toolName !== "string" ||
		typeof value.content !== "string"
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		toolName: value.toolName,
		content: truncate(value.content, MAX_TRACKED_TOOL_CONTENT_CHARS),
		isError: value.isError === true,
		timestamp: typeof value.timestamp === "number" ? value.timestamp : Date.now(),
	};
}

export function createToolWatch() {
	const states = new Map<string, ToolWatchState>();
	const stateFor = (sessionKey: string): ToolWatchState => {
		const existing = states.get(sessionKey);
		if (existing) return existing;
		const created = { completedToolCalls: new Map<string, TrackedToolExecution>() };
		states.set(sessionKey, created);
		return created;
	};
	const trackCompletedToolCall = (sessionKey: string, execution: TrackedToolExecution): void => {
		const completed = stateFor(sessionKey).completedToolCalls;
		completed.delete(execution.toolCallId);
		completed.set(execution.toolCallId, execution);
		while (completed.size > MAX_TRACKED_TOOL_EXECUTIONS) {
			const oldest = completed.keys().next().value;
			if (oldest === undefined) return;
			completed.delete(oldest);
		}
	};
	const reconcileWithContext = (sessionKey: string, context: Context): void => {
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			trackCompletedToolCall(sessionKey, {
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: truncate(contentToText(message.content), MAX_TRACKED_TOOL_CONTENT_CHARS),
				isError: message.isError,
				timestamp: message.timestamp,
			});
		}
	};
	const hydrate = (sessionKey: string, entries: readonly SessionEntry[]): void => {
		states.set(sessionKey, { completedToolCalls: new Map() });
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				reconcileWithContext(sessionKey, { messages: [entry.message] });
			} else if (entry.type === "custom" && entry.customType === TOOL_WATCH_CUSTOM_TYPE) {
				const execution = toolWatchEntry(entry.data);
				if (execution) trackCompletedToolCall(sessionKey, execution);
			}
		}
	};
	const buildPromptNote = (
		sessionKey: string | undefined,
		context: Context,
		customToolNameToSdk?: ReadonlyMap<string, string>,
	): string | undefined => {
		if (!sessionKey) return undefined;
		const resultsInContext = new Set<string>();
		const pending = new Map<string, { toolName: string; timestamp: number }>();
		for (const message of context.messages) {
			if (message.role === "toolResult") {
				resultsInContext.add(message.toolCallId);
				continue;
			}
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall")
					pending.set(block.id, { toolName: block.name, timestamp: message.timestamp });
			}
		}
		const completed = stateFor(sessionKey).completedToolCalls;
		const notes = [...pending.entries()]
			.filter(([toolCallId]) => !resultsInContext.has(toolCallId))
			.sort((left, right) => right[1].timestamp - left[1].timestamp)
			.slice(0, MAX_LEDGER_TOOL_RESULTS)
			.map(([toolCallId, pendingCall]) => {
				const execution = completed.get(toolCallId);
				if (!execution) {
					return `TOOL RESULT (missing execution ${mapPiToolNameToSdk(pendingCall.toolName, customToolNameToSdk)}, id=${toolCallId}, status=error):\nTool execution did not complete or its result was not observed. Do not guess. Call the tool again.`;
				}
				const status = execution.isError ? "error" : "ok";
				return `TOOL RESULT (recovered ${mapPiToolNameToSdk(execution.toolName, customToolNameToSdk)}, id=${toolCallId}, status=${status}):\n${truncate(execution.content || "(empty tool result)", MAX_LEDGER_TOOL_CONTENT_CHARS)}`;
			});
		return notes.length > 0 ? notes.join("\n\n") : undefined;
	};
	return {
		sessionKey: (sessionId: string): string => `session:${sessionId}`,
		trackCompletedToolCall,
		getCompletedToolCall: (sessionKey: string, toolCallId: string) =>
			states.get(sessionKey)?.completedToolCalls.get(toolCallId),
		reconcileWithContext,
		hydrate,
		buildPromptNote,
		deleteSession: (sessionKey: string): void => void states.delete(sessionKey),
	};
}

export const toolWatch = createToolWatch();

function refreshToolWatch(
	watch: ReturnType<typeof createToolWatch>,
	event: SessionStartEvent | SessionTreeEvent,
	ctx: ExtensionContext,
): void {
	void event;
	const sessionKey = watch.sessionKey(ctx.sessionManager.getSessionId());
	watch.hydrate(sessionKey, ctx.sessionManager.getBranch());
}

export function registerToolWatch(
	pi: Pick<ExtensionAPI, "on" | "appendEntry">,
	watch: ReturnType<typeof createToolWatch> = toolWatch,
): void {
	pi.on("session_start", (event, ctx) => refreshToolWatch(watch, event, ctx));
	pi.on("session_tree", (event, ctx) => refreshToolWatch(watch, event, ctx));
	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx) => {
		watch.deleteSession(watch.sessionKey(ctx.sessionManager.getSessionId()));
	});
	pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx) => {
		// Read boundary (senpi#1989): a session resumed from an earlier version
		// still carries the legacy provider id on its model, so normalize before
		// comparing. TOOL_WATCH_CUSTOM_TYPE above is a persisted token and stays.
		if (normalizeProviderId(ctx.model?.provider ?? "") !== PROVIDER_ID) return;
		const execution: ToolWatchEntry = {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			content: resultContent(event.result),
			isError: event.isError,
			timestamp: Date.now(),
		};
		const sessionKey = watch.sessionKey(ctx.sessionManager.getSessionId());
		watch.trackCompletedToolCall(sessionKey, execution);
		pi.appendEntry<ToolWatchEntry>(TOOL_WATCH_CUSTOM_TYPE, execution);
	});
}
