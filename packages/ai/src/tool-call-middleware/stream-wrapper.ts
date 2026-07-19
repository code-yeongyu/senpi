import type { AssistantMessage, AssistantMessageEventStream, Tool } from "../types.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../utils/event-stream.ts";
import { StreamMessageProjection } from "./stream-wrapper-shared.ts";
import type { ToolCallProtocol } from "./types.ts";

export function wrapStreamWithToolCallMiddleware(
	innerStream: AssistantMessageEventStream,
	protocol: ToolCallProtocol,
	tools: Tool[],
): AssistantMessageEventStream {
	const outerStream = new AssistantMessageEventStreamImpl();
	const parser = protocol.createStreamParser(tools);

	void (async (): Promise<void> => {
		let projection: StreamMessageProjection | null = null;
		let sawToolCall = false;
		let parserHasPendingInput = false;

		const flushParser = (): void => {
			if (!projection || !parserHasPendingInput) return;
			const result = projection.projectParserEvents(parser.finish());
			sawToolCall = sawToolCall || result.sawToolCall;
			projection.finishText();
			parserHasPendingInput = false;
		};

		try {
			for await (const event of innerStream) {
				switch (event.type) {
					case "start":
						projection = new StreamMessageProjection(outerStream, event.partial);
						outerStream.push({ type: "start", partial: projection.message });
						break;
					case "text_start":
						if (!projection) break;
						projection.sync(event.partial);
						projection.startText(event.contentIndex, event.partial.content[event.contentIndex]);
						break;
					case "text_delta": {
						if (!projection) break;
						projection.sync(event.partial);
						if (event.delta.length > 0) parserHasPendingInput = true;
						const result = projection.projectParserEvents(parser.feed(event.delta));
						sawToolCall = sawToolCall || result.sawToolCall;
						break;
					}
					case "text_end":
						if (!projection) break;
						projection.sync(event.partial);
						flushParser();
						break;
					case "thinking_start":
						if (!projection) break;
						projection.sync(event.partial);
						projection.startThinking(event.contentIndex, event.partial);
						break;
					case "thinking_delta":
						if (!projection) break;
						projection.sync(event.partial);
						projection.projectThinkingDelta(event.contentIndex, event.delta, event.partial);
						break;
					case "thinking_end":
						if (!projection) break;
						projection.sync(event.partial);
						projection.finishThinking(event.contentIndex, event.content, event.partial);
						break;
					case "done": {
						projection ??= new StreamMessageProjection(outerStream, event.message);
						flushParser();
						projection.finalizeDanglingToolCalls();
						const message = projection.finalize(event.message, sawToolCall);
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
						flushParser();
						projection.finalizeDanglingToolCalls();
						const message = projection.finalize(event.error, sawToolCall);
						if (projection.hasFinalizedToolCallContent()) {
							const recovered: AssistantMessage = { ...message, stopReason: "toolUse" };
							outerStream.push({ type: "done", reason: "toolUse", message: recovered });
							outerStream.end(recovered);
							return;
						}
						outerStream.push({ type: "error", reason: event.reason, error: message });
						outerStream.end(message);
						return;
					}
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						break;
				}
			}

			const innerMessage = await innerStream.result();
			projection ??= new StreamMessageProjection(outerStream, innerMessage);
			flushParser();
			projection.finalizeDanglingToolCalls();
			outerStream.end(projection.finalize(innerMessage, sawToolCall));
		} catch (error) {
			flushParser();
			projection ??= new StreamMessageProjection(outerStream, await innerStream.result());
			projection.finalizeDanglingToolCalls();
			const fallback = projection.message;
			fallback.stopReason = "error";
			fallback.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			outerStream.push({ type: "error", reason: "error", error: fallback });
			outerStream.end();
		}
	})();

	return outerStream;
}
