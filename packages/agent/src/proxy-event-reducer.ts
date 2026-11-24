import {
	type AssistantMessage,
	type AssistantMessageEvent,
	parseStreamingJson,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ProxyAssistantMessageEvent } from "./proxy.ts";

function setRawArguments(partial: AssistantMessage, contentIndex: number, content: ToolCall, raw: string): void {
	(content as ToolCall & { partialJson: string }).partialJson = raw;
	content.arguments = parseStreamingJson(raw) || {};
	partial.content[contentIndex] = { ...content }; // Trigger reactivity
}

/**
 * Process a proxy event and update the partial message.
 */
export function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const raw = (content as ToolCall & { partialJson: string }).partialJson + proxyEvent.delta;
				setRawArguments(partial, proxyEvent.contentIndex, content, raw);
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "message_tool_arguments_reset": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type !== "toolCall")
				throw new Error("Received message_tool_arguments_reset for non-toolCall content");
			setRawArguments(partial, proxyEvent.contentIndex, content, proxyEvent.rawArgumentPrefix);
			return undefined;
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const toolCall = proxyEvent.toolCall ?? content;
				delete (toolCall as ToolCall & { partialJson?: string }).partialJson;
				partial.content[proxyEvent.contentIndex] = toolCall;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.providerThinkingLevel !== undefined) {
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.providerThinkingLevel !== undefined) {
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as { type: string }).type}`);
			return undefined;
		}
	}
}
