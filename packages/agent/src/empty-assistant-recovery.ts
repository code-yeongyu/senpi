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

function isEmptyStop(message: AssistantMessage): boolean {
	return message.stopReason === "stop" && !hasVisibleAssistantContent(message);
}

function eventStartsVisibleContent(event: AssistantMessageEvent): boolean {
	return event.type === "toolcall_start" || (event.type === "text_delta" && hasVisibleText(event.delta));
}

function appendRetryDiagnostic(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		diagnostics: [
			...(message.diagnostics ?? []),
			{
				type: "empty_assistant_response_recovery",
				timestamp: Date.now(),
				details: { retries: 1 },
			},
		],
	};
}

function createEmptyResponseFailure(message: AssistantMessage): AssistantMessage {
	return {
		...appendRetryDiagnostic(message),
		content: [{ type: "text", text: EMPTY_RESPONSE_ERROR }],
		stopReason: "error",
		errorMessage: EMPTY_RESPONSE_ERROR,
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
						if (isEmptyStop(event.message)) {
							if (!retrying) {
								retry = true;
								break;
							}
							const error = createEmptyResponseFailure(event.message);
							outerStream.push({ type: "error", reason: "error", error });
							outerStream.end();
							return;
						}
						const terminal = retrying ? { ...event, message: appendRetryDiagnostic(event.message) } : event;
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

export function withEmptyAssistantRecovery<TApi extends Api>(model: Model<TApi>, streamFunction: StreamFn): StreamFn {
	if (!shouldRecoverTextToolCalls(model) && getToolCallFormat(model) === undefined) return streamFunction;
	return async (requestedModel, context, options) => {
		const createStream = (): ReturnType<StreamFn> => streamFunction(requestedModel, context, options);
		return createRetryingStream(await createStream(), createStream);
	};
}
