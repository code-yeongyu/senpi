import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai/compat";

type GatewayJson = Readonly<Record<string, unknown>>;

export async function safeGatewayResult(
	stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> },
): Promise<AssistantMessage> {
	try {
		const message = await stream.result();
		return message.stopReason === "error" || message.stopReason === "aborted"
			? safeGatewayErrorMessage(message)
			: message;
	} catch {
		return safeGatewayErrorMessage();
	}
}

export async function* piGatewayFrames(stream: AsyncIterable<AssistantMessageEvent>): AsyncIterable<unknown> {
	try {
		for await (const event of stream) yield event.type === "error" ? safeGatewayErrorEvent(event) : event;
	} catch {
		yield safeGatewayErrorEvent();
	}
	yield "[DONE]";
}

export async function* responsesGatewayFrames(
	stream: AsyncIterable<AssistantMessageEvent>,
	responseId: string,
	model: string,
	completed: (message: AssistantMessage) => void,
): AsyncIterable<unknown> {
	yield { response: { id: responseId, model, status: "in_progress" }, type: "response.created" };
	try {
		for await (const event of stream) {
			switch (event.type) {
				case "thinking_delta":
					yield { delta: event.delta, type: "response.reasoning_summary_text.delta" };
					break;
				case "text_delta":
					yield { delta: event.delta, type: "response.output_text.delta" };
					break;
				case "toolcall_delta":
					yield { delta: event.delta, type: "response.function_call_arguments.delta" };
					break;
				case "done":
					completed(event.message);
					yield { response: { id: responseId, model, status: "completed" }, type: "response.completed" };
					break;
				case "error":
					yield safeResponsesError();
					break;
				default:
					break;
			}
		}
	} catch {
		yield safeResponsesError();
	}
	yield "[DONE]";
}

export function appendGatewayAssistant(context: Context, message: AssistantMessage): Context {
	return { ...context, messages: [...context.messages, message] };
}

export function gatewayResponseBody(responseId: string, model: string, message: AssistantMessage): GatewayJson {
	return {
		id: responseId,
		model,
		object: "response",
		output: message.content,
		status: message.stopReason === "length" ? "incomplete" : message.stopReason === "stop" ? "completed" : "failed",
	};
}

function safeGatewayErrorEvent(
	event: Extract<AssistantMessageEvent, { readonly type: "error" }> | undefined = undefined,
): AssistantMessageEvent {
	return { error: safeGatewayErrorMessage(event?.error), reason: "error", type: "error" };
}

function safeGatewayErrorMessage(message: AssistantMessage | undefined = undefined): AssistantMessage {
	return {
		api: message?.api ?? "gateway",
		content: [],
		errorMessage: "gateway provider request failed",
		model: message?.model ?? "unknown",
		provider: message?.provider ?? "gateway",
		role: "assistant",
		stopReason: "error",
		timestamp: Date.now(),
		usage: message?.usage ?? {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 0,
			output: 0,
			totalTokens: 0,
		},
	};
}

function safeResponsesError(): GatewayJson {
	return { error: { message: "gateway provider request failed", type: "server_error" }, type: "error" };
}
