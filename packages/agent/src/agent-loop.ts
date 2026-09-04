/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type CursorExecResolvedCarrier,
	EventStream,
	isCursorExecResolved,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import {
	createTerminalFailureAssistantMessage,
	isStreamIdleTimeoutError,
	normalizeTerminalAssistantMessage,
	promoteStopWithPendingToolCalls,
	shouldFinalizeIdleAsStop,
	shouldTerminateAssistantTurn,
} from "./assistant-terminal-state.ts";
import { getDefaultStreamFn, withEmptyAssistantRecovery } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

class StreamIdleTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Idle timeout waiting for provider stream after ${timeoutMs}ms`);
		this.name = "StreamIdleTimeoutError";
	}
}

// The wording must keep matching the retryable-error classifier
// ("timed out" in packages/ai/src/utils/retry.ts) so a dead stream start is
// retried instead of dead-ending the session.
export class StreamStartTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(
			`Provider stream start timed out after ${timeoutMs}ms (raise streamStartTimeoutMs — retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)`,
		);
		this.name = "StreamStartTimeoutError";
	}
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let firstProviderRequest = true;
	let drainedTerminatingQueue: "steering" | "followUp" | undefined;
	let awaitingTerminatingContinuation = false;
	const refreshTerminatingQueueDrain = async (): Promise<void> => {
		if (!drainedTerminatingQueue || !config.restorePendingMessages) return;
		await config.restorePendingMessages(drainedTerminatingQueue, pendingMessages);
		pendingMessages = (await config.getSteeringMessages?.()) || [];
		drainedTerminatingQueue = pendingMessages.length > 0 ? "steering" : undefined;
		if (pendingMessages.length === 0) {
			pendingMessages = (await config.getFollowUpMessages?.()) || [];
			drainedTerminatingQueue = pendingMessages.length > 0 ? "followUp" : undefined;
		}
	};
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (lastCompletedTurn) {
				if (awaitingTerminatingContinuation) {
					// Give queue owners a boundary before refreshing messages drained from
					// a terminating turn. A clear at turn_start must discard the local
					// snapshot instead of only clearing the owner queue.
					await emit({ type: "turn_start" });
				}
				let nextTurnSnapshot: AgentLoopTurnUpdate | undefined;
				try {
					nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				} catch (error) {
					if (drainedTerminatingQueue)
						await config.restorePendingMessages?.(drainedTerminatingQueue, pendingMessages);
					throw error;
				}
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
						thinkingSelection:
							nextTurnSnapshot.thinkingSelection === undefined
								? config.thinkingSelection
								: (nextTurnSnapshot.thinkingSelection ?? undefined),
						abortServerSideFallback: nextTurnSnapshot.abortServerSideFallback ?? config.abortServerSideFallback,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				// Preparation can abort the run (for example, a cancelled compaction).
				// Bail before the next provider request and hand any drained terminating
				// queue back to its owner.
				if (signal?.aborted) {
					if (drainedTerminatingQueue)
						await config.restorePendingMessages?.(drainedTerminatingQueue, pendingMessages);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}
				if (drainedTerminatingQueue) {
					await refreshTerminatingQueueDrain();
					if (pendingMessages.length === 0) {
						await emit({ type: "agent_end", messages: newMessages });
						return;
					}
					drainedTerminatingQueue = undefined;
				}
				if (awaitingTerminatingContinuation) {
					awaitingTerminatingContinuation = false;
				} else {
					await emit({ type: "turn_start" });
				}
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const isInitialProviderRequest = firstProviderRequest;
			firstProviderRequest = false;
			const requestConfig = isInitialProviderRequest
				? {
						...config,
						timeoutMs: config.initialRequestTimeoutMs ?? config.timeoutMs,
						streamStartTimeoutMs: config.initialRequestStreamStartTimeoutMs ?? config.streamStartTimeoutMs,
					}
				: config;
			const streamed = await streamAssistantResponse(
				currentContext,
				requestConfig,
				signal,
				emit,
				withEmptyAssistantRecovery(requestConfig.model, streamFunction),
				isInitialProviderRequest ? config.timeoutMs : requestConfig.timeoutMs,
			);
			const message = promoteStopWithPendingToolCalls(streamed.message);
			const providerToolResults = streamed.providerToolResults;
			newMessages.push(message);
			const toolResults: ToolResultMessage[] = [];
			for (const result of providerToolResults) {
				await emit({ type: "message_start", message: result });
				await emit({ type: "message_end", message: result });
				currentContext.messages.push(result);
				newMessages.push(result);
				toolResults.push(result);
			}

			if (shouldTerminateAssistantTurn(message)) {
				await emit({ type: "turn_end", message, toolResults });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter(
				(c): c is AgentToolCall => c.type === "toolCall" && !isCursorExecResolved(c as CursorExecResolvedCarrier),
			);

			hasMoreToolCalls = false;
			let toolBatchTerminated = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				toolBatchTerminated = executedToolBatch.terminate;
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of executedToolBatch.messages) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			if (signal?.aborted) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			if (toolBatchTerminated) {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
				if (pendingMessages.length > 0) drainedTerminatingQueue = "steering";
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getFollowUpMessages?.()) || [];
					if (pendingMessages.length > 0) drainedTerminatingQueue = "followUp";
				}
				if (pendingMessages.length === 0) {
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}
				// Keep one boundary turn alive so a queue clear at turn_start can win
				// over the drained messages before they are injected.
				awaitingTerminatingContinuation = true;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/** Build the provider context using the same transform and conversion pipeline as an agent request. */
export async function buildProviderContext(
	context: AgentContext,
	config: Pick<AgentLoopConfig, "convertToLlm" | "transformContext">,
	signal?: AbortSignal,
): Promise<Context> {
	let messages = context.messages;
	if (config.transformContext) messages = await config.transformContext(messages, signal);
	return { systemPrompt: context.systemPrompt, messages: await config.convertToLlm(messages), tools: context.tools };
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	streamIdleTimeoutMs: number | undefined,
): Promise<{
	message: AssistantMessage;
	providerToolResults: ToolResultMessage[];
}> {
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	// Tool results delivered by a provider that executes tools mid-stream
	// (Cursor's exec channel). Buffered here and appended by the caller right
	// after the assistant message so pairs stay adjacent in the transcript.
	const providerToolResults: ToolResultMessage[] = [];
	const thinkingTiming = new Map<number, { startedAt: number; endedAt?: number }>();

	function propagateThinkingTiming(finalMessage: AssistantMessage): void {
		for (const timing of thinkingTiming.values()) {
			if (timing.endedAt === undefined) timing.endedAt = Date.now();
		}
		for (const [contentIndex, timing] of thinkingTiming) {
			const block = finalMessage.content[contentIndex];
			if (block?.type !== "thinking") continue;
			block.startedAt = timing.startedAt;
			block.endedAt = timing.endedAt;
		}
	}

	// Dedicated controller for the provider request so the loop can tear the
	// request down itself (idle timeout), not only when the caller aborts.
	const requestAbortController = new AbortController();
	let detachCallerAbort: (() => void) | undefined;
	if (signal !== undefined) {
		if (signal.aborted) {
			requestAbortController.abort(signal.reason);
		} else {
			const onCallerAbort = () => requestAbortController.abort(signal.reason);
			signal.addEventListener("abort", onCallerAbort, { once: true });
			detachCallerAbort = () => signal.removeEventListener("abort", onCallerAbort);
		}
	}

	try {
		const llmContext = await buildProviderContext(context, config, signal);

		// Resolve API key (important for expiring tokens)
		const resolvedApiKey =
			(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

		const response = await streamFunction(config.model, llmContext, {
			...config,
			streamKind: "main",
			apiKey: resolvedApiKey,
			signal: requestAbortController.signal,
			// Cursor exec bridging (ignored by every other provider): handlers
			// execute mid-stream; their paired results buffer here.
			...(config.cursorExecHandlers
				? {
						execHandlers:
							typeof config.cursorExecHandlers === "function"
								? config.cursorExecHandlers(signal ?? requestAbortController.signal)
								: config.cursorExecHandlers,
						onToolResult: (result: ToolResultMessage) => {
							providerToolResults.push(result);
						},
					}
				: {}),
		});

		const iterator = response[Symbol.asyncIterator]();
		const eventReader = createAssistantEventReader(
			iterator,
			streamIdleTimeoutMs,
			requestAbortController.signal,
			(error) => requestAbortController.abort(error),
			config.streamStartTimeoutMs,
			response,
		);
		try {
			while (true) {
				const next = await eventReader.next();
				if (next.done) break;
				const event = next.value;
				switch (event.type) {
					case "start":
						partialMessage = event.partial;
						context.messages.push(partialMessage);
						addedPartial = true;
						await emit({
							type: "message_start",
							message: { ...partialMessage },
						});
						break;

					case "text_start":
					case "text_delta":
					case "text_end":
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						if (partialMessage) {
							partialMessage = event.partial;
							if (
								event.type === "thinking_start" ||
								event.type === "thinking_delta" ||
								event.type === "thinking_end"
							) {
								let timing = thinkingTiming.get(event.contentIndex);
								if (event.type === "thinking_start" && timing === undefined) {
									timing = { startedAt: Date.now() };
									thinkingTiming.set(event.contentIndex, timing);
								}
								if (event.type === "thinking_end" && timing !== undefined) timing.endedAt = Date.now();
								const block = partialMessage.content[event.contentIndex];
								if (block?.type === "thinking" && timing !== undefined) {
									block.startedAt = timing.startedAt;
									if (timing.endedAt !== undefined) block.endedAt = timing.endedAt;
								}
							}
							context.messages[context.messages.length - 1] = partialMessage;
							await emit({
								type: "message_update",
								assistantMessageEvent: event,
								message: { ...partialMessage },
							});
						}
						break;

					case "done":
					case "error": {
						const finalMessage = normalizeTerminalAssistantMessage(await response.result(), event);
						propagateThinkingTiming(finalMessage);
						if (addedPartial) {
							context.messages[context.messages.length - 1] = finalMessage;
						} else {
							context.messages.push(finalMessage);
						}
						if (!addedPartial) {
							await emit({
								type: "message_start",
								message: { ...finalMessage },
							});
						}
						await emit({ type: "message_end", message: finalMessage });
						return { message: finalMessage, providerToolResults };
					}
				}
			}
		} finally {
			eventReader.dispose();
		}

		const finalMessage = await response.result();
		propagateThinkingTiming(finalMessage);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return { message: finalMessage, providerToolResults };
	} catch (error) {
		if (isStreamIdleTimeoutError(error) && shouldFinalizeIdleAsStop(partialMessage, providerToolResults)) {
			const finalMessage: AssistantMessage = {
				role: "assistant",
				content: partialMessage?.content ?? [{ type: "text", text: "" }],
				api: partialMessage?.api ?? config.model.api,
				provider: partialMessage?.provider ?? config.model.provider,
				model: partialMessage?.model ?? config.model.id,
				responseModel: partialMessage?.responseModel,
				responseId: partialMessage?.responseId,
				diagnostics: partialMessage?.diagnostics,
				usage: partialMessage?.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: partialMessage?.timestamp ?? Date.now(),
			};
			propagateThinkingTiming(finalMessage);
			if (addedPartial) {
				context.messages[context.messages.length - 1] = finalMessage;
			} else {
				context.messages.push(finalMessage);
				await emit({ type: "message_start", message: { ...finalMessage } });
			}
			await emit({ type: "message_end", message: finalMessage });
			return { message: finalMessage, providerToolResults };
		}
		const finalMessage = createTerminalFailureAssistantMessage(
			config.model,
			signal?.aborted ? "aborted" : "error",
			error,
			partialMessage,
		);
		propagateThinkingTiming(finalMessage);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return { message: finalMessage, providerToolResults };
	} finally {
		requestAbortController.abort();
		detachCallerAbort?.();
	}
}

const ABORTED = Symbol("aborted");

type AssistantEventReader = {
	next(): Promise<IteratorResult<AssistantMessageEvent>>;
	dispose(): void;
};

function abortError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("Request was aborted");
}

function closeAssistantIterator(iterator: AsyncIterator<AssistantMessageEvent>): void {
	void Promise.resolve(iterator.return?.()).catch(() => undefined);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}

function createAssistantEventReader(
	iterator: AsyncIterator<AssistantMessageEvent>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	onIdleTimeout?: (error: Error) => void,
	streamStartTimeoutMs?: number,
	stream?: Pick<AssistantMessageEventStream, "hasPendingLocalWork">,
): AssistantEventReader {
	const idleTimeoutMs = normalizeTimeoutMs(timeoutMs);
	const startTimeoutMs = normalizeTimeoutMs(streamStartTimeoutMs);
	let sawFirstEvent = false;
	let removeAbortListener: (() => void) | undefined;
	let abortPromise: Promise<typeof ABORTED> | undefined;

	if (signal !== undefined) {
		if (signal.aborted) {
			abortPromise = Promise.resolve(ABORTED);
		} else {
			abortPromise = new Promise<typeof ABORTED>((resolve) => {
				const abortHandler = () => resolve(ABORTED);
				signal.addEventListener("abort", abortHandler, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", abortHandler);
			});
		}
	}

	return {
		next: async () => {
			if (signal?.aborted) {
				closeAssistantIterator(iterator);
				return Promise.reject(abortError(signal.reason));
			}
			// The start bound applies only until the provider proves the request is
			// alive with its first event; afterwards the idle bound governs as before.
			const useStartBound = !sawFirstEvent && startTimeoutMs !== undefined;
			const readTimeoutMs = useStartBound ? startTimeoutMs : idleTimeoutMs;
			const makeTimeoutError = useStartBound
				? (ms: number) => new StreamStartTimeoutError(ms)
				: (ms: number) => new StreamIdleTimeoutError(ms);
			const result = await readNextAssistantEvent(
				iterator,
				readTimeoutMs,
				makeTimeoutError,
				abortPromise,
				onIdleTimeout,
				stream,
				signal,
			);
			if (!result.done) sawFirstEvent = true;
			return result;
		},
		dispose: () => removeAbortListener?.(),
	};
}

async function readNextAssistantEvent(
	iterator: AsyncIterator<AssistantMessageEvent>,
	idleTimeoutMs: number | undefined,
	makeTimeoutError: (timeoutMs: number) => Error,
	abortPromise: Promise<typeof ABORTED> | undefined,
	onIdleTimeout?: (error: Error) => void,
	stream?: Pick<AssistantMessageEventStream, "hasPendingLocalWork">,
	signal?: AbortSignal,
): Promise<IteratorResult<AssistantMessageEvent>> {
	if (idleTimeoutMs === undefined && abortPromise === undefined) {
		return iterator.next();
	}

	let timeout: ReturnType<typeof setTimeout> | undefined;
	let settled = false;

	return new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			complete();
		};

		if (idleTimeoutMs !== undefined) {
			const onIdleDeadline = () => {
				// A provider executing a server-requested tool locally (Cursor's
				// exec channel) legitimately emits no events while the tool runs.
				// That silence is tracked as local work on the stream; re-arm the
				// idle bound instead of killing a healthy request.
				if (stream?.hasPendingLocalWork?.()) {
					timeout = setTimeout(onIdleDeadline, idleTimeoutMs);
					return;
				}
				const error = makeTimeoutError(idleTimeoutMs);
				closeAssistantIterator(iterator);
				settle(() => reject(error));
				// Abort after settling so the failure surfaces as an idle timeout,
				// not as a generic abort, while the dead request still gets torn down.
				onIdleTimeout?.(error);
			};
			timeout = setTimeout(onIdleDeadline, idleTimeoutMs);
		}

		const next = abortPromise ? Promise.race([iterator.next(), abortPromise]) : iterator.next();
		void next.then(
			(result) => {
				if (result === ABORTED) {
					closeAssistantIterator(iterator);
					settle(() => reject(abortError(signal?.reason)));
					return;
				}
				settle(() => resolve(result));
			},
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

function createIncompleteToolCallErrorMessage(toolName: string, errorMessage?: string): string {
	if (errorMessage !== undefined) {
		return `${errorMessage}${errorMessage.endsWith(".") ? "" : "."} Re-issue the tool call with complete arguments.`;
	}
	return `Tool call "${toolName}" was not executed: the response ended before the tool call was complete because it hit the output token limit. Re-issue the tool call with complete arguments.`;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(createIncompleteToolCallErrorMessage(toolCall.name)),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// Same filter as the loop's collection site (defense in depth): a block
	// stamped `kCursorExecResolved` was already executed by Cursor's exec
	// channel and its result buffered; running it again would duplicate a
	// side-effecting tool.
	const toolCalls = assistantMessage.content.filter(
		(c): c is AgentToolCall => c.type === "toolCall" && !isCursorExecResolved(c as CursorExecResolvedCarrier),
	);
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: Promise<FinalizedToolCallOutcome>[] = [];
	const preparedCalls: Array<{
		preparation: PreparedToolCall | ImmediateToolCallOutcome;
		isSequential: boolean;
		dependencies: Promise<FinalizedToolCallOutcome>[];
	}> = [];
	let lastSequentialCall: Promise<FinalizedToolCallOutcome> | undefined;
	let currentParallelWave: Promise<FinalizedToolCallOutcome>[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		const isSequential = isSequentialToolCall(currentContext, toolCall);
		const dependencies = isSequential
			? [...(lastSequentialCall ? [lastSequentialCall] : []), ...currentParallelWave]
			: lastSequentialCall
				? [lastSequentialCall]
				: [];

		preparedCalls.push({ preparation, isSequential, dependencies });

		if (isSequential) {
			// Dependencies are assigned in the second phase after all preflight hooks
			// have completed, so a later preflight abort vetoes every execution.
			lastSequentialCall = undefined;
			currentParallelWave = [];
		} else {
			currentParallelWave.push(Promise.resolve(undefined as never));
		}

		if (signal?.aborted) {
			break;
		}
	}

	let previousSequential: Promise<FinalizedToolCallOutcome> | undefined;
	let previousWave: Promise<FinalizedToolCallOutcome>[] = [];
	for (const { preparation, isSequential } of preparedCalls) {
		const dependencies = isSequential
			? [...(previousSequential ? [previousSequential] : []), ...previousWave]
			: previousSequential
				? [previousSequential]
				: [];
		const finalizedCall = (async () => {
			await Promise.all(dependencies);
			const finalized = signal?.aborted
				? { toolCall: preparation.toolCall, result: createErrorToolResult("Operation aborted"), isError: true }
				: await runPreparedToolCall(currentContext, assistantMessage, preparation, config, signal, emit);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		})();
		finalizedCalls.push(finalizedCall);
		if (isSequential) {
			previousSequential = finalizedCall;
			previousWave = [];
		} else previousWave.push(finalizedCall);
	}
	const orderedFinalizedCalls = await Promise.all(finalizedCalls);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

async function runPreparedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	preparation: PreparedToolCall | ImmediateToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	if (preparation.kind === "immediate") {
		return {
			toolCall: preparation.toolCall,
			result: preparation.result,
			isError: preparation.isError,
		};
	}

	const executed = await executePreparedToolCall(preparation, signal, emit);
	return finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
}

function isSequentialToolCall(currentContext: AgentContext, toolCall: AgentToolCall): boolean {
	return currentContext.tools?.find((tool) => tool.name === toolCall.name)?.executionMode === "sequential";
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
};

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

export interface PreparedAgentToolCall {
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: unknown;
}

export function prepareAgentToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, unknown>,
	};
}

export function prepareAgentToolCall(tool: AgentTool, toolCall: AgentToolCall): PreparedAgentToolCall {
	const preparedToolCall = prepareAgentToolCallArguments(tool, toolCall);
	return {
		toolCall: preparedToolCall,
		tool,
		args: validateToolArguments(tool, preparedToolCall),
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	if (toolCall.incomplete === true) {
		return {
			kind: "immediate",
			toolCall,
			result: createErrorToolResult(createIncompleteToolCallErrorMessage(toolCall.name, toolCall.errorMessage)),
			isError: true,
		};
	}

	let tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	if (!tool && config.resolveUnknownToolCall) {
		tool = await config.resolveUnknownToolCall(toolCall.name, currentContext);
	}
	if (!tool) {
		const hint = config.removedToolHints?.[toolCall.name];
		return {
			kind: "immediate",
			toolCall,
			result: createErrorToolResult(
				hint === undefined ? `Tool ${toolCall.name} not found` : `Tool ${toolCall.name} not found. ${hint}`,
			),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareAgentToolCall(tool, toolCall);
		const validatedArgs = preparedToolCall.args;
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall: preparedToolCall.toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					toolCall,
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				toolCall,
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall: preparedToolCall.toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			toolCall,
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * Resolves as soon as `signal` aborts, so a tool that never settles and never
 * observes its signal cannot pin the run forever. Without this the abort has no
 * wakeup once `execute()` is entered: no `agent_end`, the session never goes
 * idle, and every queued prompt parks behind the session work barrier while the
 * TUI shows "Running <tool>" with a dead ESC.
 */
function abortReleasePromise(signal: AbortSignal | undefined): Promise<typeof ABORTED> | undefined {
	if (signal === undefined) return undefined;
	if (signal.aborted) return Promise.resolve(ABORTED);
	return new Promise<typeof ABORTED>((resolve) => {
		signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
	});
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const execution = prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
			if (!acceptingUpdates) return;
			updateEvents.push(
				Promise.resolve(
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						args: prepared.toolCall.arguments,
						partialResult,
					}),
				),
			);
		});
		const abortRelease = abortReleasePromise(signal);
		const settled = abortRelease ? await Promise.race([execution, abortRelease]) : await execution;
		if (settled === ABORTED) {
			void Promise.resolve(execution).catch(() => undefined);
			acceptingUpdates = false;
			await Promise.all(updateEvents);
			return { result: createErrorToolResult("Tool execution aborted"), isError: true };
		}
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result: settled, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
