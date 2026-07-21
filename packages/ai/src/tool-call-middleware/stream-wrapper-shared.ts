import type { AssistantMessage, AssistantMessageEventStream, TextContent, ToolCall } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { cloneAssistantMessageMetadata, syncAssistantMessageMetadata } from "./stream-message-metadata.ts";
import { StreamThinkingProjection } from "./stream-thinking-projection.ts";
import type { StreamParserEvent } from "./types.ts";

type PartialToolCall = ToolCall & { partialJson: string };

export type ParserProjectionResult = {
	readonly sawToolCall: boolean;
	readonly completedToolCalls: readonly ToolCall[];
};

type StreamMessageProjectionOptions = { readonly preserveSourceMetadata?: boolean };

function isPartialToolCall(block: AssistantMessage["content"][number] | undefined): block is PartialToolCall {
	return block?.type === "toolCall" && "partialJson" in block && typeof block.partialJson === "string";
}

function assertNever(value: never): never {
	throw new Error(`Unexpected parser event: ${JSON.stringify(value)}`);
}

/** Projects parser events into the canonical outer assistant stream. */
export class StreamMessageProjection {
	readonly message: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private currentInnerTextIndex: number | null = null;
	private readonly textBlockIndexByInnerIndex = new Map<number, number | null>();
	private readonly lastTextBlockIndexByInnerIndex = new Map<number, number>();
	private readonly toolCallIndexByParserIndex = new Map<number, number>();
	private readonly projectedDiagnostics: AssistantMessageDiagnostic[] = [];
	private readonly thinking: StreamThinkingProjection;
	private readonly preserveSourceMetadata: boolean;
	private source: AssistantMessage;

	constructor(
		stream: AssistantMessageEventStream,
		source: AssistantMessage,
		options: StreamMessageProjectionOptions = {},
	) {
		this.stream = stream;
		this.source = source;
		this.preserveSourceMetadata = options.preserveSourceMetadata === true;
		this.message = cloneAssistantMessageMetadata(source, [], this.projectedDiagnostics, this.preserveSourceMetadata);
		this.thinking = new StreamThinkingProjection(stream, this.message, this.preserveSourceMetadata);
	}

	sync(source: AssistantMessage): void {
		this.source = source;
		syncAssistantMessageMetadata(this.message, source, this.projectedDiagnostics, this.preserveSourceMetadata);
	}

	appendDiagnostic(diagnostic: AssistantMessageDiagnostic): void {
		this.projectedDiagnostics.push(diagnostic);
		syncAssistantMessageMetadata(this.message, this.source, this.projectedDiagnostics, this.preserveSourceMetadata);
	}

	startText(contentIndex: number, sourceBlock?: AssistantMessage["content"][number]): number {
		this.currentInnerTextIndex = contentIndex;
		const outerIndex = this.message.content.length;
		if (this.preserveSourceMetadata) {
			const block: TextContent =
				sourceBlock?.type === "text" ? { ...sourceBlock, text: "" } : { type: "text", text: "" };
			this.message.content.push(block);
			this.textBlockIndexByInnerIndex.set(contentIndex, outerIndex);
			this.lastTextBlockIndexByInnerIndex.set(contentIndex, outerIndex);
		} else {
			this.textBlockIndexByInnerIndex.set(contentIndex, null);
		}
		this.stream.push({ type: "text_start", contentIndex: outerIndex, partial: this.message });
		return outerIndex;
	}

	startThinking(contentIndex: number, source: AssistantMessage): number {
		return this.thinking.start(contentIndex, source);
	}

	projectThinkingDelta(contentIndex: number, delta: string, source: AssistantMessage): void {
		this.thinking.delta(contentIndex, delta, source);
	}

	finishThinking(contentIndex: number, content: string, source: AssistantMessage): void {
		this.thinking.end(contentIndex, content, source);
	}

	projectParserEvents(events: readonly StreamParserEvent[]): ParserProjectionResult {
		let sawToolCall = false;
		const completedToolCalls: ToolCall[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					this.pushText(event.text);
					break;
				case "toolcall_start":
					sawToolCall = true;
					this.startToolCall(event);
					break;
				case "toolcall_delta":
					sawToolCall = true;
					this.updateToolCall(event.index, event.argumentsDelta);
					break;
				case "toolcall_end": {
					sawToolCall = true;
					const completed = this.endToolCall(event);
					if (completed) completedToolCalls.push(completed);
					break;
				}
				default:
					assertNever(event);
			}
		}
		return { sawToolCall, completedToolCalls };
	}

	finishText(): void {
		const outerContentIndex =
			this.currentInnerTextIndex == null
				? null
				: (this.textBlockIndexByInnerIndex.get(this.currentInnerTextIndex) ??
					(this.preserveSourceMetadata
						? this.lastTextBlockIndexByInnerIndex.get(this.currentInnerTextIndex)
						: null) ??
					null);
		if (outerContentIndex != null) {
			const block = this.message.content[outerContentIndex];
			if (block?.type === "text") {
				this.stream.push({
					type: "text_end",
					contentIndex: outerContentIndex,
					content: block.text,
					partial: this.message,
				});
			}
		}
		this.currentInnerTextIndex = null;
	}

	finalizeDanglingToolCalls(): void {
		for (const [contentIndex, block] of this.message.content.entries()) {
			if (!isPartialToolCall(block)) continue;
			const finalToolCall: ToolCall = {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: block.arguments,
				incomplete: true,
				errorMessage: "Tool call stream ended before completion",
			};
			this.message.content[contentIndex] = finalToolCall;
			for (const [parserIndex, mappedContentIndex] of this.toolCallIndexByParserIndex) {
				if (mappedContentIndex === contentIndex) this.toolCallIndexByParserIndex.delete(parserIndex);
			}
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: finalToolCall, partial: this.message });
		}
	}

	finalize(doneMessage: AssistantMessage, sawToolCall: boolean): AssistantMessage {
		const finalMessage = cloneAssistantMessageMetadata(
			doneMessage,
			this.message.content,
			this.projectedDiagnostics,
			this.preserveSourceMetadata,
		);
		if (
			(sawToolCall || this.hasFinalizedToolCallContent()) &&
			(finalMessage.stopReason === "stop" || finalMessage.stopReason === "length")
		) {
			finalMessage.stopReason = "toolUse";
		}
		return finalMessage;
	}

	hasFinalizedToolCallContent(): boolean {
		return this.message.content.some((block) => block.type === "toolCall" && !isPartialToolCall(block));
	}

	private pushText(text: string): void {
		if (this.currentInnerTextIndex == null) return;
		let contentIndex = this.textBlockIndexByInnerIndex.get(this.currentInnerTextIndex) ?? null;
		if (contentIndex == null) {
			contentIndex = this.message.content.length;
			this.message.content.push({ type: "text", text });
			this.textBlockIndexByInnerIndex.set(this.currentInnerTextIndex, contentIndex);
			this.lastTextBlockIndexByInnerIndex.set(this.currentInnerTextIndex, contentIndex);
		} else {
			const block = this.message.content[contentIndex];
			if (block?.type !== "text") return;
			block.text += text;
		}
		this.stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.message });
	}

	private startToolCall(event: Extract<StreamParserEvent, { type: "toolcall_start" }>): void {
		if (this.currentInnerTextIndex != null) {
			const textIndex = this.textBlockIndexByInnerIndex.get(this.currentInnerTextIndex);
			const block = textIndex == null ? undefined : this.message.content[textIndex];
			if (
				textIndex === this.message.content.length - 1 &&
				block?.type === "text" &&
				block.text.length === 0 &&
				block.textSignature === undefined
			) {
				this.message.content.pop();
			}
		}
		const contentIndex = this.message.content.length;
		const toolCall: PartialToolCall = {
			type: "toolCall",
			id: event.id,
			name: event.name,
			arguments: {},
			partialJson: "",
		};
		this.message.content.push(toolCall);
		this.toolCallIndexByParserIndex.set(event.index, contentIndex);
		if (this.currentInnerTextIndex != null) this.textBlockIndexByInnerIndex.set(this.currentInnerTextIndex, null);
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.message });
	}

	private updateToolCall(parserIndex: number, delta: string): void {
		const contentIndex = this.toolCallIndexByParserIndex.get(parserIndex);
		if (contentIndex == null) return;
		const block = this.message.content[contentIndex];
		if (!isPartialToolCall(block)) return;
		block.partialJson += delta;
		block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialJson);
		this.stream.push({ type: "toolcall_delta", contentIndex, delta, partial: this.message });
	}

	private endToolCall(event: Extract<StreamParserEvent, { type: "toolcall_end" }>): ToolCall | undefined {
		const contentIndex = this.toolCallIndexByParserIndex.get(event.index);
		if (contentIndex == null) return undefined;
		const finalToolCall: ToolCall = {
			type: "toolCall",
			id: event.id,
			name: event.name,
			arguments: event.arguments,
			...(event.incomplete === true ? { incomplete: true } : {}),
			...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
		};
		this.message.content[contentIndex] = finalToolCall;
		this.toolCallIndexByParserIndex.delete(event.index);
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall: finalToolCall, partial: this.message });
		return finalToolCall;
	}
}
