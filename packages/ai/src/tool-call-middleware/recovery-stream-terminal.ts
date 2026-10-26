import type { AssistantMessage, AssistantMessageEventStream, StopReason } from "../types.ts";
import { parseServerFallbackReceipt, SERVER_FALLBACK_ABORTED_DIAGNOSTIC } from "../utils/server-fallback-receipt.ts";
import type { StreamMessageProjection } from "./stream-wrapper-shared.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Removes the tool calls `removes` selects and returns the first index whose block vanished or moved, if any. */
export function removeToolCalls(
	message: AssistantMessage,
	removes: (index: number) => boolean = () => true,
): number | undefined {
	const from = message.content.findIndex((block, index) => block.type === "toolCall" && removes(index));
	if (from < 0) return undefined;
	message.content = message.content.filter((block, index) => block.type !== "toolCall" || !removes(index));
	return from;
}

function supersededBoundary(message: AssistantMessage): number {
	return message.content.findLastIndex(
		(block) => block.type === "providerNative" && parseServerFallbackReceipt(block.raw) !== undefined,
	);
}

/** A server fallback receipt supersedes every client tool call before it. */
function discardSupersededTools(message: AssistantMessage): number | undefined {
	const boundary = supersededBoundary(message);
	return removeToolCalls(message, (index) => index < boundary);
}

function firstIndex(left: number | undefined, right: number | undefined): number | undefined {
	return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

/** The capture hint that marks a terminal whose content no longer matches the announced blocks from an index on. */
export function rewriteHint(rewrittenFrom: number | undefined): { rewrittenFrom: number } | undefined {
	return rewrittenFrom === undefined ? undefined : { rewrittenFrom };
}

/** Emits one terminal event after recovery projection state has been flushed. */
export class RecoveryStreamTerminal {
	private emitted = false;
	private readonly stream: AssistantMessageEventStream;

	constructor(stream: AssistantMessageEventStream) {
		this.stream = stream;
	}

	done(
		projection: StreamMessageProjection,
		source: AssistantMessage,
		sawToolCall: boolean,
		reason: Extract<StopReason, "stop" | "length" | "toolUse">,
	): void {
		if (this.emitted) return;
		projection.finalizeDanglingToolCalls();
		const message = projection.finalize(source, sawToolCall);
		const superseded = supersededBoundary(message) >= 0;
		const rewrittenFrom = discardSupersededTools(message);
		const recovered = (!superseded && sawToolCall) || message.content.some((block) => block.type === "toolCall");
		const finalReason = recovered && (reason === "stop" || reason === "length") ? "toolUse" : reason;
		message.stopReason = finalReason;
		this.emit({ type: "done", reason: finalReason, message }, rewrittenFrom);
	}

	sourceError(
		projection: StreamMessageProjection,
		source: AssistantMessage,
		sawToolCall: boolean,
		reason: Extract<StopReason, "aborted" | "error">,
	): void {
		if (this.emitted) return;
		// The forwarded source holds source indices, not the projected ones the stream announced: no index is provable.
		if (source.diagnostics?.some((entry) => entry.type === SERVER_FALLBACK_ABORTED_DIAGNOSTIC)) {
			this.emit({ type: "error", reason, error: source }, 0);
			return;
		}
		const rewrittenFrom = discardSupersededTools(projection.message);
		projection.finalizeDanglingToolCalls();
		const message = projection.finalize(source, sawToolCall);
		if (reason === "aborted") {
			const aborted = removeToolCalls(message);
			message.stopReason = "aborted";
			message.errorMessage ??= "Request was aborted";
			this.emit({ type: "error", reason: "aborted", error: message }, firstIndex(rewrittenFrom, aborted));
			return;
		}
		if (projection.hasFinalizedToolCallContent()) {
			message.stopReason = "toolUse";
			this.emit({ type: "done", reason: "toolUse", message }, rewrittenFrom);
			return;
		}
		message.stopReason = "error";
		this.emit({ type: "error", reason: "error", error: message }, rewrittenFrom);
	}

	iteratorFailure(projection: StreamMessageProjection | null, error: unknown): void {
		if (this.emitted) return;
		if (!projection) {
			this.emitted = true;
			this.stream.fail(error);
			return;
		}
		projection.finalizeDanglingToolCalls();
		const message = projection.finalize(projection.message, false);
		message.stopReason = "error";
		message.errorMessage = errorText(error) || "Assistant message stream failed";
		this.emit({ type: "error", reason: "error", error: message });
	}

	exhausted(projection: StreamMessageProjection | null): void {
		if (this.emitted) return;
		if (!projection) {
			this.iteratorFailure(null, new Error("Assistant message stream ended without a terminal event"));
			return;
		}
		projection.finalizeDanglingToolCalls();
		const message = projection.finalize(projection.message, false);
		message.stopReason = "error";
		message.errorMessage = "Assistant message stream ended without a terminal event";
		this.emit({ type: "error", reason: "error", error: message });
	}

	cancelled(projection: StreamMessageProjection | null): void {
		if (this.emitted) return;
		if (!projection) {
			this.iteratorFailure(null, new Error("Assistant message stream consumption was cancelled"));
			return;
		}
		projection.finalizeDanglingToolCalls();
		const message = projection.finalize(projection.message, false);
		const rewrittenFrom = removeToolCalls(message);
		message.stopReason = "error";
		message.errorMessage = "Assistant message stream consumption was cancelled";
		this.emit({ type: "error", reason: "error", error: message }, rewrittenFrom);
	}

	private emit(
		event: Extract<Parameters<AssistantMessageEventStream["push"]>[0], { type: "done" | "error" }>,
		rewrittenFrom?: number,
	): void {
		if (this.emitted) return;
		this.emitted = true;
		this.stream.push(event, rewriteHint(rewrittenFrom));
		this.stream.end();
	}
}
