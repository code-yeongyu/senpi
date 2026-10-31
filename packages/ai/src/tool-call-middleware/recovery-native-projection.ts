import type { AssistantMessage, AssistantMessageEventStream, ToolCall } from "../types.ts";
import { type AssistantProgress, pushAssistantProgress } from "../utils/assistant-capture.ts";
import type { StreamParserEvent, ToolCallFormat } from "./types.ts";

type ContentBlock = AssistantMessage["content"][number];
type ContentRange = { start: number; end: number };
type NativeLifecycle = "started" | "ended";

function cloneContentBlock(block: ContentBlock): ContentBlock {
	if (block.type === "toolCall") return { ...block, arguments: { ...block.arguments } };
	return { ...block };
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return { ...toolCall, arguments: { ...toolCall.arguments } };
}

/** Maintains source-index order and native/recovered ID ownership for recovery streams. */
export class RecoveryNativeProjection {
	private readonly stream: AssistantMessageEventStream;
	private readonly message: AssistantMessage;
	private readonly rangesByInnerIndex = new Map<number, ContentRange>();
	private readonly copiedInnerIndexes = new Set<number>();
	private readonly pendingProgress = new Map<number, AssistantProgress[]>();
	private readonly nativeLifecycleByInnerIndex = new Map<number, NativeLifecycle>();
	private readonly reservedIds = new Set<string>();
	private readonly recoveredIds = new Set<string>();
	private readonly recoveredIdByParserIndex = new Map<number, string>();
	private readonly recoveredIdPrefix: string;
	private highestProjectedInnerIndex = -1;
	private nextRecoveredId = 0;

	constructor(stream: AssistantMessageEventStream, message: AssistantMessage, protocol: ToolCallFormat = "antml") {
		this.stream = stream;
		this.message = message;
		this.recoveredIdPrefix = `recovered-${protocol}-`;
	}

	reserveVisibleIds(source: AssistantMessage): void {
		for (const block of source.content) {
			if (block.type === "toolCall") this.reservedIds.add(block.id);
		}
	}

	synchronizeLower(source: AssistantMessage, contentIndex: number): boolean {
		for (let innerIndex = 0; innerIndex < contentIndex && innerIndex < source.content.length; innerIndex += 1) {
			if (this.rangesByInnerIndex.has(innerIndex)) continue;
			if (!this.appendUnannounced(source, innerIndex)) return false;
		}
		return true;
	}

	synchronizeRemaining(source: AssistantMessage): boolean {
		for (let innerIndex = 0; innerIndex < source.content.length; innerIndex += 1) {
			if (this.rangesByInnerIndex.has(innerIndex)) continue;
			if (!this.appendUnannounced(source, innerIndex)) return false;
		}
		return true;
	}

	startText(innerIndex: number, outerIndex: number): boolean {
		if (!this.recordRange(innerIndex, { start: outerIndex, end: this.message.content.length }, false)) return false;
		return true;
	}

	recordProjectedBlock(innerIndex: number, outerIndex: number): boolean {
		return this.recordRange(innerIndex, { start: outerIndex, end: outerIndex + 1 }, true);
	}

	/**
	 * Relays a source control to the outer block that copies its source block. Controls of a block the projection
	 * rebuilds (prose split into text and recovered calls) describe no outer block and are dropped; controls of a
	 * block not projected yet wait for it.
	 */
	relayProgress(progress: AssistantProgress): void {
		const range = this.rangesByInnerIndex.get(progress.contentIndex);
		if (!range) {
			const pending = this.pendingProgress.get(progress.contentIndex);
			if (pending) pending.push(progress);
			else this.pendingProgress.set(progress.contentIndex, [progress]);
			return;
		}
		if (!this.copiedInnerIndexes.has(progress.contentIndex)) return;
		pushAssistantProgress(
			this.stream,
			range.start === progress.contentIndex ? progress : Object.freeze({ ...progress, contentIndex: range.start }),
		);
	}

	extendText(innerIndex: number): void {
		const range = this.rangesByInnerIndex.get(innerIndex);
		if (range) range.end = this.message.content.length;
	}

	projectNativeStart(source: AssistantMessage, innerIndex: number): "projected" | "collision" | "invalid" {
		if (this.nativeLifecycleByInnerIndex.has(innerIndex) || this.rangesByInnerIndex.has(innerIndex)) return "invalid";
		const block = source.content[innerIndex];
		if (block?.type !== "toolCall" || innerIndex <= this.highestProjectedInnerIndex) return "invalid";
		if (this.recoveredIds.has(block.id)) return "collision";
		this.reservedIds.add(block.id);
		const outerIndex = this.message.content.length;
		this.message.content.push(cloneContentBlock(block));
		this.nativeLifecycleByInnerIndex.set(innerIndex, "started");
		this.stream.push({ type: "toolcall_start", contentIndex: outerIndex, partial: this.message });
		// Recorded after the start, as a thinking copy is, so controls held for the call follow its start event. The
		// guards above already rule out both reasons recordRange refuses.
		return this.recordRange(innerIndex, { start: outerIndex, end: outerIndex + 1 }, true) ? "projected" : "invalid";
	}

	projectNativeDelta(source: AssistantMessage, innerIndex: number, delta: string): boolean {
		if (this.nativeLifecycleByInnerIndex.get(innerIndex) !== "started") return false;
		const outerIndex = this.rangesByInnerIndex.get(innerIndex)?.start;
		const block = source.content[innerIndex];
		if (outerIndex == null || block?.type !== "toolCall") return false;
		this.message.content[outerIndex] = cloneContentBlock(block);
		this.stream.push({ type: "toolcall_delta", contentIndex: outerIndex, delta, partial: this.message });
		return true;
	}

	projectNativeEnd(innerIndex: number, toolCall: ToolCall): boolean {
		if (this.nativeLifecycleByInnerIndex.get(innerIndex) !== "started") return false;
		const outerIndex = this.rangesByInnerIndex.get(innerIndex)?.start;
		if (outerIndex == null) return false;
		const finalToolCall = cloneToolCall(toolCall);
		this.message.content[outerIndex] = finalToolCall;
		this.nativeLifecycleByInnerIndex.set(innerIndex, "ended");
		this.stream.push({
			type: "toolcall_end",
			contentIndex: outerIndex,
			toolCall: finalToolCall,
			partial: this.message,
		});
		return true;
	}

	assignRecoveredIds(events: readonly StreamParserEvent[]): StreamParserEvent[] {
		return events.map((event) => {
			if (event.type === "toolcall_start") {
				const id = this.allocateRecoveredId();
				this.recoveredIdByParserIndex.set(event.index, id);
				return { ...event, id };
			}
			if (event.type === "toolcall_end") {
				const id = this.recoveredIdByParserIndex.get(event.index) ?? event.id;
				this.recoveredIdByParserIndex.delete(event.index);
				return { ...event, id };
			}
			return event;
		});
	}

	private appendUnannounced(source: AssistantMessage, innerIndex: number): boolean {
		const block = source.content[innerIndex];
		if (!block || innerIndex <= this.highestProjectedInnerIndex) return false;
		if (block.type === "toolCall" && this.recoveredIds.has(block.id)) return false;
		const outerIndex = this.message.content.length;
		this.message.content.push(cloneContentBlock(block));
		return this.recordRange(innerIndex, { start: outerIndex, end: outerIndex + 1 }, true);
	}

	/** Flushes the controls held for `innerIndex`; a copied block with a start event records its range after that start. */
	private recordRange(innerIndex: number, range: ContentRange, copiesSource: boolean): boolean {
		if (this.rangesByInnerIndex.has(innerIndex) || innerIndex <= this.highestProjectedInnerIndex) return false;
		this.rangesByInnerIndex.set(innerIndex, range);
		this.highestProjectedInnerIndex = innerIndex;
		if (copiesSource) this.copiedInnerIndexes.add(innerIndex);
		const pending = this.pendingProgress.get(innerIndex) ?? [];
		this.pendingProgress.delete(innerIndex);
		for (const progress of pending) this.relayProgress(progress);
		return true;
	}

	private allocateRecoveredId(): string {
		for (;;) {
			const id = `${this.recoveredIdPrefix}${this.nextRecoveredId}`;
			this.nextRecoveredId += 1;
			if (this.reservedIds.has(id)) continue;
			this.reservedIds.add(id);
			this.recoveredIds.add(id);
			return id;
		}
	}
}
