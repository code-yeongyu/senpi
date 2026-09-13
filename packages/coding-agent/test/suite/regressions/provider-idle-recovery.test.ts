import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;

function createAssistantStream(): EventStream<AssistantMessageEvent, AssistantMessage> {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected non-terminal faux stream event");
		},
	);
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function idleTimeoutError() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `Idle timeout waiting for provider stream after ${DEFAULT_PROVIDER_IDLE_TIMEOUT_MS}ms`,
	});
}

function genericTimeoutError() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "Request timed out.",
	});
}

function getStreamStartTimeoutMs(options: unknown): number | undefined {
	if (!options || typeof options !== "object" || !("streamStartTimeoutMs" in options)) return undefined;
	const value = (options as { streamStartTimeoutMs?: unknown }).streamStartTimeoutMs;
	return typeof value === "number" ? value : undefined;
}

describe("provider idle recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps the configured provider timeouts on the retry request", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 0,
					provider: { streamRetryTimeoutMs: 45_000 },
				},
			},
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			fauxAssistantMessage("retry recovered"),
			fauxAssistantMessage("ordinary turn recovered"),
		]);

		await harness.session.prompt("first request");
		await harness.session.prompt("later request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
		]);
	});

	it("does not re-enable disabled stream guards during a timeout retry", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = undefined;
		harness.agent.streamStartTimeoutMs = undefined;
		harness.setResponses([genericTimeoutError(), fauxAssistantMessage("retry recovered")]);

		await harness.session.prompt("first request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([undefined, undefined]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			undefined,
			undefined,
		]);
	});

	// The screenshot showed foreground eval aborting without any further user input.
	// Its 276.3s duration is compatible with a leftover continuation deadline, not
	// an eval hard limit: provider recovery must stop that timer before local work.
	it("does not abort a recovered retry's long-running tool before provider call 3 receives its result", async () => {
		vi.useFakeTimers();
		const retryTimeoutMs = 120_000;
		const toolDurationMs = 276_300;
		const toolEntered = createDeferred();
		const releaseTool = createDeferred();
		let toolSignal: AbortSignal | undefined;
		const toolResult = { content: [{ type: "text" as const, text: "local-eval-result" }], details: {} };
		const tool: AgentTool = {
			name: "eval",
			label: "Eval",
			description: "Run deferred local work",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, signal) {
				toolSignal = signal;
				toolEntered.resolve();
				await releaseTool.promise;
				return toolResult;
			},
		};
		const harness = await createHarness({
			tools: [tool],
			settings: {
				retry: {
					enabled: true,
					modelFallback: false,
					maxRetries: 1,
					baseDelayMs: 0,
					provider: { streamRetryTimeoutMs: retryTimeoutMs },
				},
			},
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			fauxAssistantMessage(fauxToolCall("eval", {}, { id: "recovered-eval" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("completed"),
		]);
		const retryStarted = createDeferred();
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarted.resolve();
		});

		const prompt = harness.session.prompt("run the local evaluation");
		try {
			await retryStarted.promise;
			await vi.advanceTimersByTimeAsync(0);
			await toolEntered.promise;
			const parentSignal = harness.agent.signal;
			expect(parentSignal).toBeDefined();
			expect(toolSignal).toBe(parentSignal);
			expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
			expect(harness.faux.getCallLog()).toHaveLength(2);
			const settledWork = harness.session.waitForSettledSessionWork();

			await vi.advanceTimersByTimeAsync(retryTimeoutMs - 1);
			expect(parentSignal?.aborted).toBe(false);
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(2);
			expect.soft(parentSignal?.aborted, "recovered provider watchdog must not abort the parent Agent").toBe(false);

			await vi.advanceTimersByTimeAsync(toolDurationMs - retryTimeoutMs - 1);
			releaseTool.resolve();
			await settledWork;
			await prompt;

			const calls = harness.faux.getCallLog();
			expect(calls, "tool result must reach provider call 3 without another user prompt").toHaveLength(3);
			expect(calls[2].context.messages).toContainEqual(
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "recovered-eval",
					isError: false,
					content: toolResult.content,
				}),
			);
			expect(parentSignal?.aborted).toBe(false);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			unsubscribe();
			releaseTool.resolve();
			if (harness.session.isStreaming) await harness.session.abort();
			await prompt;
			await harness.session.waitForSettledSessionWork();
		}
	});

	it("bounds a hung retry continuation after a provider transport timeout", async () => {
		vi.useFakeTimers();
		const retryTimeoutMs = 1_000;
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					modelFallback: false,
					maxRetries: 1,
					baseDelayMs: 0,
					provider: { streamRetryTimeoutMs: retryTimeoutMs },
				},
			},
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = undefined;
		harness.agent.streamStartTimeoutMs = undefined;
		const retryRequestStarted = createDeferred();
		let providerCalls = 0;
		harness.agent.streamFunction = () => {
			providerCalls++;
			const stream = createAssistantStream();
			if (providerCalls === 1) {
				queueMicrotask(() => stream.push({ type: "error", reason: "error", error: genericTimeoutError() }));
			} else {
				retryRequestStarted.resolve();
			}
			return stream;
		};

		const prompt = harness.session.prompt("first request");
		let settled = false;
		let settledWork: Promise<void> | undefined;
		try {
			await vi.runOnlyPendingTimersAsync();
			await retryRequestStarted.promise;
			settledWork = harness.session.waitForSettledSessionWork().then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(retryTimeoutMs);
			await vi.advanceTimersByTimeAsync(0);

			expect(settled).toBe(true);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(providerCalls).toBe(2);
		} finally {
			if (harness.session.isStreaming) await harness.session.abort();
			await prompt;
			await settledWork;
		}
	});

	it("spends the full retry budget after watchdog-aborted continuations", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					modelFallback: false,
					maxRetries: 3,
					baseDelayMs: 0,
					provider: { streamRetryTimeoutMs: 50 },
				},
			},
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = undefined;
		harness.agent.streamStartTimeoutMs = undefined;
		let providerCalls = 0;
		harness.agent.streamFunction = () => {
			providerCalls++;
			const stream = createAssistantStream();
			if (providerCalls === 1) {
				queueMicrotask(() =>
					stream.push({
						type: "error",
						reason: "error",
						error: fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "Provider stream start timed out after 90000ms",
						}),
					}),
				);
			}
			return stream;
		};

		const prompt = harness.session.prompt("first request");
		try {
			await vi.runOnlyPendingTimersAsync();
			for (let attempt = 0; attempt < 3; attempt++) {
				await vi.advanceTimersByTimeAsync(51);
				await vi.advanceTimersByTimeAsync(0);
			}
			await prompt;
			expect(providerCalls).toBe(4);
			expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
				{
					success: false,
					attempt: 3,
					finalError: expect.stringContaining("Provider retry continuation watchdog timed out"),
				},
			]);
			expect(harness.eventsOfType("auto_retry_end").at(-1)?.finalError).not.toContain("Request was aborted");
			const tail = harness.session.messages.at(-1);
			expect(tail).toMatchObject({ stopReason: "aborted", abortSource: "provider" });
		} finally {
			if (harness.session.isStreaming) await harness.session.abort();
		}
	});

	it("expires a no-first-event retry at the reconciled continuation bound without shortening the provider guards", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { retry: { enabled: true, modelFallback: false, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		const providerOptions: Array<{ timeoutMs?: number; streamStartTimeoutMs?: number }> = [];
		const secondRequestStarted = createDeferred();
		let providerCalls = 0;
		harness.agent.streamFunction = (_model, _context, options) => {
			providerCalls++;
			providerOptions.push({
				timeoutMs: options?.timeoutMs,
				streamStartTimeoutMs: getStreamStartTimeoutMs(options),
			});
			const stream = createAssistantStream();
			if (providerCalls === 1) {
				queueMicrotask(() => {
					const error = idleTimeoutError();
					stream.push({ type: "error", reason: "error", error });
				});
			} else {
				secondRequestStarted.resolve();
			}
			return stream;
		};
		const retryStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "auto_retry_start") return;
				unsubscribe();
				resolve();
			});
		});

		const prompt = harness.session.prompt("first request");
		try {
			await retryStarted;
			await vi.runOnlyPendingTimersAsync();
			await secondRequestStarted.promise;
			await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_START_TIMEOUT_MS - 1);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(0);

			expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
				{
					success: false,
					attempt: 1,
					finalError: `Provider stream start timed out after ${DEFAULT_STREAM_START_TIMEOUT_MS}ms (raise streamStartTimeoutMs — retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)`,
				},
			]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).not.toContain(
				"Request was aborted",
			);
			expect(providerOptions).toEqual([
				{
					timeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
					streamStartTimeoutMs: DEFAULT_STREAM_START_TIMEOUT_MS,
				},
				{
					timeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
					streamStartTimeoutMs: DEFAULT_STREAM_START_TIMEOUT_MS,
				},
			]);
		} finally {
			if (harness.session.isStreaming) await harness.session.abort();
			await prompt;
		}
	});
});
