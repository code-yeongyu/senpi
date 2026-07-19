import type { AssistantMessage, AssistantMessageEventStream, Tool } from "../types.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../utils/event-stream.ts";
import { type RecoveryContentKind, RecoveryContentLifecycle } from "./recovery-content-lifecycle.ts";
import { RecoveryNativeProjection } from "./recovery-native-projection.ts";
import { type RecoveryStreamFailure, terminateRecoveryStreamForFailure } from "./recovery-stream-failure.ts";
import { RecoveryTextProjection } from "./recovery-text-projection.ts";
import { StreamMessageProjection } from "./stream-wrapper-shared.ts";

export function wrapStreamWithInvokeRecovery(
	innerStream: AssistantMessageEventStream,
	tools: readonly Tool[],
): AssistantMessageEventStream {
	const outerStream = new AssistantMessageEventStreamImpl();

	void (async (): Promise<void> => {
		let projection: StreamMessageProjection | null = null;
		let nativeProjection: RecoveryNativeProjection | null = null;
		let textProjection: RecoveryTextProjection | null = null;
		let sawToolCall = false;
		const contentLifecycle = new RecoveryContentLifecycle();

		const finishText = (): void => {
			if (!textProjection) return;
			sawToolCall = textProjection.finish() || sawToolCall;
			textProjection = null;
		};

		const finalize = (source: AssistantMessage): AssistantMessage => {
			if (!projection) return source;
			projection.finalizeDanglingToolCalls();
			return projection.finalize(source, sawToolCall);
		};

		const terminateForFailure = (source: AssistantMessage, failure: RecoveryStreamFailure): void => {
			if (!projection) return;
			finishText();
			terminateRecoveryStreamForFailure(outerStream, projection, source, failure);
		};

		const prepareContentEvent = (source: AssistantMessage, contentIndex: number): boolean => {
			if (!projection || !nativeProjection) return false;
			if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || contentIndex >= source.content.length) {
				terminateForFailure(source, "invalid_native_event_order");
				return false;
			}
			projection.sync(source);
			nativeProjection.reserveVisibleIds(source);
			if (nativeProjection.synchronizeLower(source, contentIndex)) return true;
			terminateForFailure(source, "collision");
			return false;
		};

		const canStart = (
			source: AssistantMessage,
			contentIndex: number,
			kind: RecoveryContentKind,
			failure: RecoveryStreamFailure = "invalid_content_event_order",
		): boolean => {
			if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || contentIndex >= source.content.length) {
				terminateForFailure(source, failure);
				return false;
			}
			const block = source.content[contentIndex];
			const blockMatches =
				(kind === "text" && block?.type === "text") ||
				(kind === "thinking" && block?.type === "thinking") ||
				(kind === "toolCall" && block?.type === "toolCall");
			if (blockMatches && contentLifecycle.canStart(contentIndex)) return true;
			terminateForFailure(source, failure);
			return false;
		};

		const isActive = (
			source: AssistantMessage,
			contentIndex: number,
			kind: RecoveryContentKind,
			failure: RecoveryStreamFailure = "invalid_content_event_order",
		): boolean => {
			if (contentLifecycle.isActive(contentIndex, kind)) return true;
			terminateForFailure(source, failure);
			return false;
		};

		const synchronizeTerminal = (source: AssistantMessage): boolean => {
			projection ??= new StreamMessageProjection(outerStream, source, { preserveSourceMetadata: true });
			nativeProjection ??= new RecoveryNativeProjection(outerStream, projection.message);
			projection.sync(source);
			nativeProjection.reserveVisibleIds(source);
			finishText();
			if (nativeProjection.synchronizeRemaining(source)) return true;
			terminateForFailure(source, "collision");
			return false;
		};

		try {
			for await (const event of innerStream) {
				switch (event.type) {
					case "start":
						projection = new StreamMessageProjection(outerStream, event.partial, {
							preserveSourceMetadata: true,
						});
						nativeProjection = new RecoveryNativeProjection(outerStream, projection.message);
						nativeProjection.reserveVisibleIds(event.partial);
						outerStream.push({ type: "start", partial: projection.message });
						break;
					case "text_start": {
						if (!canStart(event.partial, event.contentIndex, "text")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !projection || !nativeProjection)
							return;
						const nextText = new RecoveryTextProjection(tools, projection, nativeProjection, event.contentIndex);
						if (!nextText.start(event.partial)) {
							terminateForFailure(event.partial, "invalid_native_event_order");
							return;
						}
						textProjection = nextText;
						contentLifecycle.start(event.contentIndex, "text");
						break;
					}
					case "text_delta":
						if (!isActive(event.partial, event.contentIndex, "text")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !textProjection) return;
						sawToolCall = textProjection.feed(event.delta) || sawToolCall;
						break;
					case "text_end":
						if (!isActive(event.partial, event.contentIndex, "text")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex)) return;
						finishText();
						contentLifecycle.end(event.contentIndex, "text");
						break;
					case "done": {
						if (!synchronizeTerminal(event.message)) return;
						const message = finalize(event.message);
						const recovered = sawToolCall || message.content.some((block) => block.type === "toolCall");
						const reason =
							recovered && (event.reason === "stop" || event.reason === "length") ? "toolUse" : event.reason;
						outerStream.push({ type: "done", reason, message });
						outerStream.end();
						return;
					}
					case "error": {
						if (!projection) {
							outerStream.push(event);
							outerStream.end(event.error);
							return;
						}
						if (!synchronizeTerminal(event.error)) return;
						const message = finalize(event.error);
						if (projection.hasFinalizedToolCallContent()) {
							message.stopReason = "toolUse";
							outerStream.push({ type: "done", reason: "toolUse", message });
							outerStream.end(message);
							return;
						}
						outerStream.push({ type: "error", reason: event.reason, error: message });
						outerStream.end(message);
						return;
					}
					case "toolcall_start": {
						if (!canStart(event.partial, event.contentIndex, "toolCall", "invalid_native_event_order")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !nativeProjection) return;
						const status = nativeProjection.projectNativeStart(event.partial, event.contentIndex);
						if (status !== "projected") {
							terminateForFailure(
								event.partial,
								status === "collision" ? "collision" : "invalid_native_event_order",
							);
							return;
						}
						contentLifecycle.start(event.contentIndex, "toolCall");
						sawToolCall = true;
						break;
					}
					case "toolcall_delta":
						if (!isActive(event.partial, event.contentIndex, "toolCall", "invalid_native_event_order")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !nativeProjection) return;
						if (!nativeProjection.projectNativeDelta(event.partial, event.contentIndex, event.delta)) {
							terminateForFailure(event.partial, "invalid_native_event_order");
							return;
						}
						break;
					case "toolcall_end":
						if (!isActive(event.partial, event.contentIndex, "toolCall", "invalid_native_event_order")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !nativeProjection) return;
						if (!nativeProjection.projectNativeEnd(event.contentIndex, event.toolCall)) {
							terminateForFailure(event.partial, "invalid_native_event_order");
							return;
						}
						contentLifecycle.end(event.contentIndex, "toolCall");
						sawToolCall = true;
						break;
					case "thinking_start": {
						if (!canStart(event.partial, event.contentIndex, "thinking")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !projection || !nativeProjection)
							return;
						const outerIndex = projection.startThinking(event.contentIndex, event.partial);
						if (!nativeProjection.recordProjectedBlock(event.contentIndex, outerIndex)) {
							terminateForFailure(event.partial, "invalid_native_event_order");
							return;
						}
						contentLifecycle.start(event.contentIndex, "thinking");
						break;
					}
					case "thinking_delta":
						if (!isActive(event.partial, event.contentIndex, "thinking")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !projection) return;
						projection.projectThinkingDelta(event.contentIndex, event.delta, event.partial);
						break;
					case "thinking_end":
						if (!isActive(event.partial, event.contentIndex, "thinking")) return;
						if (!prepareContentEvent(event.partial, event.contentIndex) || !projection) return;
						projection.finishThinking(event.contentIndex, event.content, event.partial);
						contentLifecycle.end(event.contentIndex, "thinking");
						break;
				}
			}

			const innerMessage = await innerStream.result();
			if (!synchronizeTerminal(innerMessage)) return;
			outerStream.end(finalize(innerMessage));
		} catch (error) {
			if (!projection) {
				outerStream.fail(error);
				return;
			}
			finishText();
			const message = finalize(projection.message);
			message.stopReason = "error";
			message.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			outerStream.push({ type: "error", reason: "error", error: message });
			outerStream.end();
		}
	})();

	return outerStream;
}
