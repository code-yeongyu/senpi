import type { AssistantMessage, AssistantMessageEventStream, Tool, ToolCall } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../utils/event-stream.ts";
import { createAntmlInvokeRecoveryStreamParser } from "./protocols/antml/recovery-stream.ts";
import { createRecoveryCodeMask, type RecoveryCodeMaskSegment } from "./recovery-code-mask.ts";
import { RecoveryNativeProjection } from "./recovery-native-projection.ts";
import { type RecoveryStreamFailure, terminateRecoveryStreamForFailure } from "./recovery-stream-failure.ts";
import { StreamMessageProjection } from "./stream-wrapper-shared.ts";
import type { StreamParserEvent } from "./types.ts";

function appendRecoveryDiagnostic(message: AssistantMessage, toolCall: ToolCall): void {
	appendAssistantMessageDiagnostic(message, {
		type: "text_tool_call_recovery",
		timestamp: Date.now(),
		details: {
			protocol: "antml",
			toolName: toolCall.name,
			id: toolCall.id,
			status: toolCall.incomplete === true ? "incomplete" : "complete",
		},
	});
}

export function wrapStreamWithInvokeRecovery(
	innerStream: AssistantMessageEventStream,
	tools: readonly Tool[],
): AssistantMessageEventStream {
	const outerStream = new AssistantMessageEventStreamImpl();
	const parser = createAntmlInvokeRecoveryStreamParser(tools);
	const mask = createRecoveryCodeMask();

	void (async (): Promise<void> => {
		let projection: StreamMessageProjection | null = null;
		let nativeProjection: RecoveryNativeProjection | null = null;
		let sawToolCall = false;
		let activeInvoke = false;
		let textOpen = false;
		let currentInnerTextIndex: number | null = null;
		let textBuffer = "";

		const flushText = (): void => {
			if (!projection || textBuffer.length === 0) return;
			projection.projectParserEvents([{ type: "text", text: textBuffer }]);
			textBuffer = "";
		};

		const projectParserEvents = (events: readonly StreamParserEvent[]): void => {
			if (!projection || !nativeProjection) return;
			for (const event of nativeProjection.assignRecoveredIds(events)) {
				if (event.type === "text") {
					textBuffer += event.text;
					continue;
				}
				flushText();
				const result = projection.projectParserEvents([event]);
				sawToolCall = sawToolCall || result.sawToolCall;
				if (event.type === "toolcall_start") activeInvoke = true;
				if (event.type === "toolcall_end") {
					activeInvoke = false;
					for (const toolCall of result.completedToolCalls) appendRecoveryDiagnostic(projection.message, toolCall);
				}
			}
			if (currentInnerTextIndex != null) nativeProjection.extendText(currentInnerTextIndex);
		};

		const processSegment = (segment: RecoveryCodeMaskSegment): void => {
			if (segment.recoveryBoundary) projectParserEvents(parser.interrupt());
			if (segment.scan) {
				projectParserEvents(parser.feed(segment.text));
			} else {
				textBuffer += segment.text;
			}
		};

		const feedText = (text: string): void => {
			for (let index = 0; index < text.length; index += 1) {
				const character = text.charAt(index);
				const options = activeInvoke ? { activeInvoke: true } : undefined;
				for (const segment of mask.feed(character, options)) processSegment(segment);
			}
			flushText();
		};

		const finishText = (): void => {
			if (!projection || !textOpen) return;
			for (const segment of mask.finish()) processSegment(segment);
			projectParserEvents(parser.finish());
			flushText();
			projection.finishText();
			if (currentInnerTextIndex != null) nativeProjection?.extendText(currentInnerTextIndex);
			currentInnerTextIndex = null;
			textOpen = false;
		};

		const finalize = (source: AssistantMessage): AssistantMessage => {
			if (!projection) return source;
			projection.finalizeDanglingToolCalls();
			const message = projection.finalize(source, sawToolCall);
			if (projection.message.diagnostics) message.diagnostics = [...projection.message.diagnostics];
			return message;
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

		try {
			for await (const event of innerStream) {
				switch (event.type) {
					case "start":
						projection = new StreamMessageProjection(outerStream, event.partial);
						nativeProjection = new RecoveryNativeProjection(outerStream, projection.message);
						nativeProjection.reserveVisibleIds(event.partial);
						outerStream.push({ type: "start", partial: projection.message });
						break;
					case "text_start":
						if (!prepareContentEvent(event.partial, event.contentIndex) || !projection || !nativeProjection)
							return;
						currentInnerTextIndex = event.contentIndex;
						nativeProjection.startText(event.contentIndex);
						projection.startText(event.contentIndex);
						textOpen = true;
						break;
					case "text_delta":
						if (!prepareContentEvent(event.partial, event.contentIndex)) return;
						feedText(event.delta);
						break;
					case "text_end":
						if (!prepareContentEvent(event.partial, event.contentIndex)) return;
						finishText();
						break;
					case "done": {
						projection ??= new StreamMessageProjection(outerStream, event.message);
						finishText();
						const message = finalize(event.message);
						const recovered = sawToolCall || projection.hasFinalizedToolCallContent();
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
						projection.sync(event.error);
						finishText();
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
						if (!prepareContentEvent(event.partial, event.contentIndex) || !nativeProjection) return;
						const status = nativeProjection.projectNativeStart(event.partial, event.contentIndex);
						if (status !== "projected") {
							terminateForFailure(
								event.partial,
								status === "collision" ? "collision" : "invalid_native_event_order",
							);
							return;
						}
						sawToolCall = true;
						break;
					}
					case "toolcall_delta":
						if (!prepareContentEvent(event.partial, event.contentIndex) || !nativeProjection) return;
						if (!nativeProjection.projectNativeDelta(event.partial, event.contentIndex, event.delta)) {
							terminateForFailure(event.partial, "invalid_native_event_order");
							return;
						}
						break;
					case "toolcall_end":
						if (!prepareContentEvent(event.partial, event.contentIndex) || !nativeProjection) return;
						if (!nativeProjection.projectNativeEnd(event.contentIndex, event.toolCall)) {
							terminateForFailure(event.partial, "invalid_native_event_order");
							return;
						}
						sawToolCall = true;
						break;
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
						if (!prepareContentEvent(event.partial, event.contentIndex)) return;
						break;
				}
			}

			const innerMessage = await innerStream.result();
			projection ??= new StreamMessageProjection(outerStream, innerMessage);
			finishText();
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
