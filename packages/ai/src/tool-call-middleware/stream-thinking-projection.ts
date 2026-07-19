import type { AssistantMessage, AssistantMessageEventStream, ThinkingContent } from "../types.ts";

function cloneThinking(block: ThinkingContent, thinking = block.thinking): ThinkingContent {
	return { ...block, thinking };
}

/** Replays canonical thinking events without exposing their content to text parsers. */
export class StreamThinkingProjection {
	private readonly stream: AssistantMessageEventStream;
	private readonly message: AssistantMessage;
	private readonly outerIndexByInnerIndex = new Map<number, number>();

	constructor(stream: AssistantMessageEventStream, message: AssistantMessage) {
		this.stream = stream;
		this.message = message;
	}

	start(innerIndex: number, source: AssistantMessage): number {
		const sourceBlock = source.content[innerIndex];
		const block: ThinkingContent =
			sourceBlock?.type === "thinking" ? cloneThinking(sourceBlock) : { type: "thinking", thinking: "" };
		const outerIndex = this.message.content.length;
		this.message.content.push(block);
		this.outerIndexByInnerIndex.set(innerIndex, outerIndex);
		this.stream.push({ type: "thinking_start", contentIndex: outerIndex, partial: this.message });
		return outerIndex;
	}

	delta(innerIndex: number, delta: string, source: AssistantMessage): void {
		const outerIndex = this.outerIndexByInnerIndex.get(innerIndex);
		if (outerIndex == null) return;
		const current = this.message.content[outerIndex];
		if (current?.type !== "thinking") return;
		const sourceBlock = source.content[innerIndex];
		this.message.content[outerIndex] =
			sourceBlock?.type === "thinking"
				? cloneThinking(sourceBlock)
				: cloneThinking(current, current.thinking + delta);
		this.stream.push({ type: "thinking_delta", contentIndex: outerIndex, delta, partial: this.message });
	}

	end(innerIndex: number, content: string, source: AssistantMessage): void {
		const outerIndex = this.outerIndexByInnerIndex.get(innerIndex);
		if (outerIndex == null) return;
		const current = this.message.content[outerIndex];
		if (current?.type !== "thinking") return;
		const sourceBlock = source.content[innerIndex];
		this.message.content[outerIndex] =
			sourceBlock?.type === "thinking" ? cloneThinking(sourceBlock, content) : cloneThinking(current, content);
		this.stream.push({ type: "thinking_end", contentIndex: outerIndex, content, partial: this.message });
	}
}
