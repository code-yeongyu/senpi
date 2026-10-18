import type { AssistantMessage, AssistantMessageEventStream, StopReason } from "../types.ts";
import { parseServerFallbackReceipt, SERVER_FALLBACK_ABORTED_DIAGNOSTIC } from "../utils/server-fallback-receipt.ts";
import type { StreamMessageProjection } from "./stream-wrapper-shared.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function discardSupersededTools(message: AssistantMessage): boolean {
	const boundary = message.content.findLastIndex(
		(block) => block.type === "providerNative" && parseServerFallbackReceipt(block.raw) !== undefined,
	);
	if (boundary < 0) return false;
	message.content = message.content.filter((block, index) => index > boundary || block.type !== "toolCall");
	return true;
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
		const superseded = discardSupersededTools(message);
		const recovered = (!superseded && sawToolCall) || message.content.some((block) => block.type === "toolCall");
		const finalReason = recovered && (reason === "stop" || reason === "length") ? "toolUse" : reason;
		message.stopReason = finalReason;
		this.emit({ type: "done", reason: finalReason, message });
	}

	sourceError(
		projection: StreamMessageProjection,
		source: AssistantMessage,
		sawToolCall: boolean,
		reason: Extract<StopReason, "aborted" | "error">,
	): void {
		if (this.emitted) return;
		if (source.diagnostics?.some((entry) => entry.type === SERVER_FALLBACK_ABORTED_DIAGNOSTIC)) {
			this.emit({ type: "error", reason, error: source });
			return;
		}
		discardSupersededTools(projection.message);
		projection.finalizeDanglingToolCalls();
		const message = projection.finalize(source, sawToolCall);
		if (reason === "aborted") {
			message.content = message.content.filter((block) => block.type !== "toolCall");
			message.stopReason = "aborted";
			message.errorMessage ??= "Request was aborted";
			this.emit({ type: "error", reason: "aborted", error: message });
			return;
		}
		if (projection.hasFinalizedToolCallContent()) {
			message.stopReason = "toolUse";
			this.emit({ type: "done", reason: "toolUse", message });
			return;
		}
		message.stopReason = "error";
		this.emit({ type: "error", reason: "error", error: message });
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
		message.content = message.content.filter((block) => block.type !== "toolCall");
		message.stopReason = "error";
		message.errorMessage = "Assistant message stream consumption was cancelled";
		this.emit({ type: "error", reason: "error", error: message });
	}

	private emit(event: Extract<Parameters<AssistantMessageEventStream["push"]>[0], { type: "done" | "error" }>): void {
		if (this.emitted) return;
		this.emitted = true;
		this.stream.push(event);
		this.stream.end();
	}
}
