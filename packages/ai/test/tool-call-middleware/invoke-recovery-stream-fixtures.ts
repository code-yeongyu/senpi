import type {
	AssistantMessage,
	AssistantMessageEvent,
	ProviderNativeContent,
	StopReason,
	ToolCall,
} from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";

function createUsage(): AssistantMessage["usage"] {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		content,
		usage: createUsage(),
		stopReason,
		timestamp: 123,
	};
}

/** Mutable producer fixture for the real assistant event stream contract. */
export class TextStreamHarness {
	readonly inner = new AssistantMessageEventStream();
	readonly partial = createAssistantMessage([]);
	private sourceText = "";

	start(): void {
		this.inner.push({ type: "start", partial: this.partial });
		this.inner.push({ type: "text_start", contentIndex: 0, partial: this.partial });
		this.partial.content.push({ type: "text", text: "" });
	}

	delta(text: string): void {
		this.sourceText += text;
		const block = this.partial.content[0];
		if (block?.type === "text") {
			block.text = this.sourceText;
		}
		this.inner.push({ type: "text_delta", contentIndex: 0, delta: text, partial: this.partial });
	}

	finish(reason: Extract<StopReason, "stop" | "length"> = "stop"): void {
		this.inner.push({ type: "text_end", contentIndex: 0, content: this.sourceText, partial: this.partial });
		this.inner.push({
			type: "done",
			reason,
			message: createAssistantMessage([{ type: "text", text: this.sourceText }], reason),
		});
	}
}

type NativePartialToolCall = ToolCall & { partialJson: string };

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return { ...toolCall, arguments: { ...toolCall.arguments } };
}

/** Scripted producer for mixed canonical content blocks and native tool events. */
export class NativeStreamHarness {
	readonly inner = new AssistantMessageEventStream();
	readonly partial = createAssistantMessage([]);

	private snapshot(): AssistantMessage {
		const content = this.partial.content.map((block) =>
			block.type === "toolCall" ? cloneToolCall(block) : { ...block },
		);
		return createAssistantMessage(content, this.partial.stopReason);
	}

	start(): void {
		this.inner.push({ type: "start", partial: this.snapshot() });
	}

	appendProviderNative(block: ProviderNativeContent): number {
		const contentIndex = this.partial.content.length;
		this.partial.content.push({ ...block });
		return contentIndex;
	}

	startText(): number {
		const contentIndex = this.partial.content.length;
		this.partial.content.push({ type: "text", text: "" });
		this.inner.push({ type: "text_start", contentIndex, partial: this.snapshot() });
		return contentIndex;
	}

	textDelta(contentIndex: number, delta: string): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "text") throw new Error(`Expected text block at ${contentIndex}`);
		block.text += delta;
		this.inner.push({ type: "text_delta", contentIndex, delta, partial: this.snapshot() });
	}

	endText(contentIndex: number): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "text") throw new Error(`Expected text block at ${contentIndex}`);
		this.inner.push({ type: "text_end", contentIndex, content: block.text, partial: this.snapshot() });
	}

	startNative(toolCall: ToolCall): number {
		const contentIndex = this.partial.content.length;
		const block: NativePartialToolCall = { ...cloneToolCall(toolCall), partialJson: "" };
		this.partial.content.push(block);
		this.inner.push({ type: "toolcall_start", contentIndex, partial: this.snapshot() });
		return contentIndex;
	}

	deltaNative(contentIndex: number, delta: string, current: ToolCall): void {
		const block = this.partial.content[contentIndex];
		if (block?.type !== "toolCall") throw new Error(`Expected tool call block at ${contentIndex}`);
		const partialJson = "partialJson" in block && typeof block.partialJson === "string" ? block.partialJson : "";
		const updated: NativePartialToolCall = { ...cloneToolCall(current), partialJson: partialJson + delta };
		this.partial.content[contentIndex] = updated;
		this.inner.push({ type: "toolcall_delta", contentIndex, delta, partial: this.snapshot() });
	}

	endNative(contentIndex: number, toolCall: ToolCall): void {
		const finalToolCall = cloneToolCall(toolCall);
		this.partial.content[contentIndex] = finalToolCall;
		this.inner.push({ type: "toolcall_end", contentIndex, toolCall: finalToolCall, partial: this.snapshot() });
	}

	finish(reason: Extract<StopReason, "stop" | "length" | "toolUse"> = "toolUse"): void {
		const content = this.partial.content.map((block) =>
			block.type === "toolCall" ? cloneToolCall(block) : { ...block },
		);
		this.inner.push({ type: "done", reason, message: createAssistantMessage(content, reason) });
	}
}

export async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export async function collectIterator(
	iterator: AsyncIterator<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for (;;) {
		const next = await iterator.next();
		if (next.done) {
			return events;
		}
		events.push(next.value);
	}
}

export async function nextEvent(iterator: AsyncIterator<AssistantMessageEvent>): Promise<AssistantMessageEvent> {
	const next = await iterator.next();
	if (next.done) {
		throw new Error("Assistant event stream ended before the expected event");
	}
	return next.value;
}

export function textFrom(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}
