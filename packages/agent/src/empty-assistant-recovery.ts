import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	EMPTY_RESPONSE_ERROR,
	EMPTY_TOOL_USE_ERROR,
	FORWARDED_EMPTY_RESPONSE_ERROR,
	FORWARDED_EMPTY_TOOL_USE_ERROR,
	getToolCallFormat,
	hasKimiTextToolCallRecovery,
	hasVisibleAssistantContent,
	hasVisibleText,
	type Model,
	shouldRecoverTextToolCalls,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "./types.ts";

type StreamFactory = () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

function isEmptyStop(message: AssistantMessage): boolean {
	return message.stopReason === "stop" && !hasVisibleAssistantContent(message);
}

function isEmptyToolUse(message: AssistantMessage): boolean {
	return message.stopReason === "toolUse" && !message.content.some((block) => block.type === "toolCall");
}

interface CommitPolicy {
	/**
	 * Whether reasoning commits the attempt. True for models whose thinking channel is native
	 * (Claude, antml/other text formats): a reasoning model shows its work for seconds before the
	 * first text or tool call, and holding that back blanks the transcript for the whole phase.
	 * False for the Kimi XTML lane: its thinking channel is the documented misrouting vector for
	 * text tool calls and `recoverKimiXtmlThinking` only rewrites the finished message, so a
	 * leaked protocol fragment forwarded live could never be retracted (#759).
	 */
	readonly thinkingCommits: boolean;
}

/** Zero-width or whitespace-only deltas never commit, so format-only noise stays buffered. */
function isMeaningfulContentEvent(event: AssistantMessageEvent, policy: CommitPolicy): boolean {
	switch (event.type) {
		case "toolcall_start":
			return true;
		case "text_delta":
			return hasVisibleText(event.delta);
		case "text_end":
			return hasVisibleText(event.content);
		case "thinking_delta":
			return policy.thinkingCommits && hasVisibleText(event.delta);
		case "thinking_end":
			return policy.thinkingCommits && hasVisibleText(event.content);
		default:
			return false;
	}
}

function appendRetryDiagnostic(
	message: AssistantMessage,
	type = "empty_assistant_response_recovery",
	details: Record<string, unknown> = { retries: 1 },
): AssistantMessage {
	return {
		...message,
		diagnostics: [...(message.diagnostics ?? []), { type, timestamp: Date.now(), details }],
	};
}

function recoveryDiagnosticType(toolUse: boolean): string {
	return toolUse ? "empty_tool_use_response_recovery" : "empty_assistant_response_recovery";
}

function createEmptyResponseFailure(message: AssistantMessage, toolUse = false): AssistantMessage {
	const errorMessage = toolUse ? EMPTY_TOOL_USE_ERROR : EMPTY_RESPONSE_ERROR;
	return {
		...appendRetryDiagnostic(message, recoveryDiagnosticType(toolUse)),
		content: [{ type: "text", text: errorMessage }],
		stopReason: "error",
		errorMessage,
	};
}

/**
 * An attempt whose reasoning already streamed cannot be replayed here: a second `start` would
 * duplicate the partial message, and stitching this attempt's thinking onto a retry's content
 * would break provider replay of signed thinking blocks. The turn ends as a retryable error
 * (see the classifier in pi-ai's retry.ts) and keeps the content the user already saw, so the
 * session's turn retry re-requests it with the failed attempt dropped from the provider context.
 */
function createForwardedEmptyFailure(message: AssistantMessage, toolUse: boolean): AssistantMessage {
	return {
		...appendRetryDiagnostic(message, recoveryDiagnosticType(toolUse), { retries: 0, forwarded: true }),
		stopReason: "error",
		errorMessage: toolUse ? FORWARDED_EMPTY_TOOL_USE_ERROR : FORWARDED_EMPTY_RESPONSE_ERROR,
	};
}

function createRetryingStream(
	firstStream: AssistantMessageEventStream,
	createStream: StreamFactory,
	policy: CommitPolicy,
) {
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
							if (forwarding) {
								outerStream.push({
									type: "error",
									reason: "error",
									error: createForwardedEmptyFailure(event.message, emptyToolUse),
								});
								outerStream.end();
								return;
							}
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
										recoveryDiagnosticType(isEmptyToolUse(event.message)),
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
					if (isMeaningfulContentEvent(event, policy)) {
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
	const policy: CommitPolicy = { thinkingCommits: !hasKimiTextToolCallRecovery(model) };
	return async (requestedModel, context, options) => {
		const createStream = (): ReturnType<StreamFn> => streamFunction(requestedModel, context, options);
		return createRetryingStream(await createStream(), createStream, policy);
	};
}
