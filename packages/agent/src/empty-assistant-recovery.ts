import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getToolCallFormat,
	hasVisibleAssistantContent,
	hasVisibleText,
	type Model,
	shouldRecoverTextToolCalls,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "./types.ts";

type StreamFactory = () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

const EMPTY_RESPONSE_ERROR = "Model returned an empty response twice";
const EMPTY_TOOL_USE_ERROR = "Model returned tool_use without a tool call twice";

function isEmptyStop(message: AssistantMessage): boolean {
	return message.stopReason === "stop" && !hasVisibleAssistantContent(message);
}

function isEmptyToolUse(message: AssistantMessage): boolean {
	return message.stopReason === "toolUse" && !message.content.some((block) => block.type === "toolCall");
}

function eventStartsVisibleContent(event: AssistantMessageEvent): boolean {
	return event.type === "toolcall_start" || (event.type === "text_delta" && hasVisibleText(event.delta));
}

function appendRetryDiagnostic(
	message: AssistantMessage,
	type = "empty_assistant_response_recovery",
): AssistantMessage {
	return {
		...message,
		diagnostics: [...(message.diagnostics ?? []), { type, timestamp: Date.now(), details: { retries: 1 } }],
	};
}

function createEmptyResponseFailure(message: AssistantMessage, toolUse = false): AssistantMessage {
	const errorMessage = toolUse ? EMPTY_TOOL_USE_ERROR : EMPTY_RESPONSE_ERROR;
	return {
		...appendRetryDiagnostic(message, toolUse ? "empty_tool_use_response_recovery" : undefined),
		content: [{ type: "text", text: errorMessage }],
		stopReason: "error",
		errorMessage,
	};
}

function createRetryingStream(firstStream: AssistantMessageEventStream, createStream: StreamFactory) {
	const outerStream = createAssistantMessageEventStream();

	void (async (): Promise<void> => {
		try {
			let stream = firstStream;
			let retrying = false;
			for (;;) {
				const buffered: AssistantMessageEvent[] = [];
				let forwarding = false;
				let retry = false;
				for await (const event of stream) {
					if (event.type === "done") {
						const emptyToolUse = isEmptyToolUse(event.message);
						if (isEmptyStop(event.message) || emptyToolUse) {
							if (!retrying) {
								retry = true;
								break;
							}
							const error = createEmptyResponseFailure(event.message, emptyToolUse);
							outerStream.push({ type: "error", reason: "error", error });
							outerStream.end();
							return;
						}
						const terminal = retrying
							? {
									...event,
									message: appendRetryDiagnostic(
										event.message,
										isEmptyToolUse(event.message) ? "empty_tool_use_response_recovery" : undefined,
									),
								}
							: event;
						if (!forwarding) {
							for (const pending of buffered) outerStream.push(pending);
						}
						outerStream.push(terminal);
						outerStream.end();
						return;
					}
					if (event.type === "error") {
						if (!forwarding) {
							for (const pending of buffered) outerStream.push(pending);
						}
						outerStream.push(event);
						outerStream.end();
						return;
					}
					if (forwarding) {
						outerStream.push(event);
						continue;
					}
					buffered.push(event);
					if (eventStartsVisibleContent(event)) {
						for (const pending of buffered) outerStream.push(pending);
						forwarding = true;
					}
				}
				if (!retry) {
					outerStream.end(retrying ? appendRetryDiagnostic(await stream.result()) : await stream.result());
					return;
				}
				retrying = true;
				stream = await createStream();
			}
		} catch (error) {
			outerStream.fail(error);
		}
	})();

	return outerStream;
}

// Wrapping replaces the provider stream with a buffering proxy, which does not carry the
// underlying stream's liveness surface (trackLocalWork/hasPendingLocalWork) that the loop's
// idle watchdog reads. Only wrap models that actually need stream-level recovery; the
// empty-tool_use contradiction is normalized for every model by the agent loop instead.
export function withEmptyAssistantRecovery<TApi extends Api>(model: Model<TApi>, streamFunction: StreamFn): StreamFn {
	if (!shouldRecoverTextToolCalls(model) && getToolCallFormat(model) === undefined) return streamFunction;
	return async (requestedModel, context, options) => {
		const createStream = (): ReturnType<StreamFn> => streamFunction(requestedModel, context, options);
		return createRetryingStream(await createStream(), createStream);
	};
}
