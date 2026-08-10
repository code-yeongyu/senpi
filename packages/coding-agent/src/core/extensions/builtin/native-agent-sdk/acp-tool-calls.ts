import type { SessionUpdate, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { NativeAgentPermissionRequest } from "./permission.ts";

export type TrackedToolCall = Pick<NativeAgentPermissionRequest, "kind" | "title" | "rawInput">;

export function contentInput(content: ToolCall["content"] | ToolCallUpdate["content"]): unknown {
	const text = content
		?.flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : []))
		.join("");
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function trackToolCall(update: SessionUpdate, toolCalls: Map<string, TrackedToolCall>): void {
	switch (update.sessionUpdate) {
		case "tool_call":
			toolCalls.set(update.toolCallId, {
				kind: update.kind,
				title: update.title,
				rawInput: update.rawInput ?? contentInput(update.content),
			});
			return;
		case "tool_call_update": {
			const previous = toolCalls.get(update.toolCallId);
			toolCalls.set(update.toolCallId, {
				kind: update.kind ?? previous?.kind,
				title: update.title ?? previous?.title ?? "Native agent tool request",
				rawInput: update.rawInput ?? contentInput(update.content) ?? previous?.rawInput,
			});
			return;
		}
		default:
			return;
	}
}
