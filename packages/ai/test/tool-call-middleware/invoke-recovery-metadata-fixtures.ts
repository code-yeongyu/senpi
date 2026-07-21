import type {
	AssistantMessage,
	AssistantMessageEvent,
	ProviderNativeContent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";

export type MetadataAssistantMessage = AssistantMessage & {
	fixtureMetadata: { traceId: string; labels: string[] };
};

const usage: AssistantMessage["usage"] = {
	input: 101,
	output: 37,
	cacheRead: 23,
	cacheWrite: 19,
	cacheWrite1h: 17,
	reasoning: 11,
	totalTokens: 180,
	cost: {
		input: 0.101,
		output: 0.037,
		cacheRead: 0.023,
		cacheWrite: 0.019,
		total: 0.18,
	},
};

export function createMetadataMessage(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
): MetadataAssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-requested",
		responseModel: "claude-routed",
		responseId: "msg-response-9",
		diagnostics: [{ type: "existing_diagnostic", timestamp: 9, details: { retained: true } }],
		content,
		usage: structuredClone(usage),
		stopReason,
		timestamp: 9009,
		fixtureMetadata: { traceId: "trace-9", labels: ["metadata", "stable-order"] },
	};
}

function cloneBlock(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	if (block.type === "toolCall") return { ...block, arguments: { ...block.arguments } };
	return { ...block };
}

function cloneMessage(message: MetadataAssistantMessage): MetadataAssistantMessage {
	return {
		...message,
		content: message.content.map(cloneBlock),
		usage: { ...message.usage, cost: { ...message.usage.cost } },
		diagnostics: message.diagnostics?.map((diagnostic) => ({ ...diagnostic })),
		fixtureMetadata: {
			traceId: message.fixtureMetadata.traceId,
			labels: [...message.fixtureMetadata.labels],
		},
	};
}

type NativePartialToolCall = ToolCall & { partialJson: string };

export class MetadataStreamHarness {
	readonly inner = new AssistantMessageEventStream();
	readonly partial = createMetadataMessage([]);

	start(): void {
		this.inner.push({ type: "start", partial: cloneMessage(this.partial) });
	}

	startText(block: TextContent): number {
		const contentIndex = this.partial.content.length;
		this.partial.content.push({ ...block });
		this.inner.push({ type: "text_start", contentIndex, partial: cloneMessage(this.partial) });
		return contentIndex;
	}

	textDelta(contentIndex: number, delta: string): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "text") throw new Error(`Expected text block at ${contentIndex}`);
		block.text += delta;
		this.inner.push({ type: "text_delta", contentIndex, delta, partial: cloneMessage(this.partial) });
	}

	endText(contentIndex: number): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "text") throw new Error(`Expected text block at ${contentIndex}`);
		this.inner.push({ type: "text_end", contentIndex, content: block.text, partial: cloneMessage(this.partial) });
	}

	startThinking(block: ThinkingContent): number {
		const contentIndex = this.partial.content.length;
		this.partial.content.push({ ...block });
		this.inner.push({ type: "thinking_start", contentIndex, partial: cloneMessage(this.partial) });
		return contentIndex;
	}

	thinkingDelta(contentIndex: number, delta: string): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "thinking") throw new Error(`Expected thinking block at ${contentIndex}`);
		block.thinking += delta;
		this.inner.push({ type: "thinking_delta", contentIndex, delta, partial: cloneMessage(this.partial) });
	}

	endThinking(contentIndex: number): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "thinking") throw new Error(`Expected thinking block at ${contentIndex}`);
		this.inner.push({
			type: "thinking_end",
			contentIndex,
			content: block.thinking,
			partial: cloneMessage(this.partial),
		});
	}

	appendProviderNative(block: ProviderNativeContent): number {
		const contentIndex = this.partial.content.length;
		this.partial.content.push({ ...block });
		return contentIndex;
	}

	startNative(toolCall: ToolCall): number {
		const contentIndex = this.partial.content.length;
		const block: NativePartialToolCall = { ...toolCall, arguments: { ...toolCall.arguments }, partialJson: "" };
		this.partial.content.push(block);
		this.inner.push({ type: "toolcall_start", contentIndex, partial: cloneMessage(this.partial) });
		return contentIndex;
	}

	endNative(contentIndex: number, toolCall: ToolCall): void {
		const finalToolCall = { ...toolCall, arguments: { ...toolCall.arguments } };
		this.partial.content[contentIndex] = finalToolCall;
		this.inner.push({
			type: "toolcall_end",
			contentIndex,
			toolCall: finalToolCall,
			partial: cloneMessage(this.partial),
		});
	}

	finish(reason: Extract<StopReason, "stop" | "length" | "toolUse"> = "toolUse"): void {
		this.partial.stopReason = reason;
		this.inner.push({ type: "done", reason, message: cloneMessage(this.partial) });
	}
}

export async function collectEventSnapshots(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(structuredClone(event));
	return events;
}
