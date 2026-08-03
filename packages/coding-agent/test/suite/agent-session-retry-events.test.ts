import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const probePrimary = "faux/faux-1";
const probeFallback = "faux/faux-2";
const hint1258ms = "HTTP 429: rate_limit_error (retry-after-ms: 1258)";

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries after a transient error and succeeds", async () => {
		const extensionWillRetry: Array<boolean | undefined> = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", (event) => {
						extensionWillRetry.push(event.willRetry);
					});
				},
			],
		});
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(extensionWillRetry).toEqual([true, false]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("hinted 429 within tier1 cap uses half-hint as first probe delay", async () => {
		// intentionally replaced by hint-aware tier routing (plan todo 6):
		// hint 5ms <= 300_000 tier1 cap -> first auto_retry_start delayMs is ceil(5/2) = 3
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let retryStartDelayMs: number | undefined;
		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					retryStartDelayMs = event.delayMs;
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "rate_limit_exceeded: retry-after-ms: 5",
			}),
			fauxAssistantMessage("recovered"),
		]);

		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;

		expect(retryStartDelayMs).toBe(3); // ceil(5/2) Tier-1 half-probe
		expect(harness.faux.state.callCount).toBe(1);

		await promptPromise;

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("hinted 429 within tier1 cap waits in-turn past the legacy provider delay cap", async () => {
		// intentionally replaced by hint-aware tier routing (plan todo 6):
		// hint 75ms <= 300_000 tier1 cap -> in-turn retry with first probe ceil(75/2) = 38ms,
		// the legacy provider.maxRetryDelayMs gate no longer applies to 429-class failures.
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetryDelayMs: 50 } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "rate_limit_exceeded: retry-after-ms: 75",
			}),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([38]); // ceil(75/2)
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("success"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("retries timed out aborted responses while preserving queued steering", async () => {
		// given
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let firstCallStarted!: () => void;
		let releaseTimeout!: () => void;
		let steeringCallStarted!: () => void;
		const sawFirstCall = new Promise<void>((resolve) => {
			firstCallStarted = resolve;
		});
		const timeoutReady = new Promise<void>((resolve) => {
			releaseTimeout = resolve;
		});
		const sawSteeringCall = new Promise<void>((resolve) => {
			steeringCallStarted = resolve;
		});
		harness.setResponses([
			async () => {
				firstCallStarted();
				await timeoutReady;
				return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request timed out." });
			},
			fauxAssistantMessage("recovered after timeout"),
			async () => {
				steeringCallStarted();
				return fauxAssistantMessage("recovered queued steering");
			},
		]);

		// when
		const promptPromise = harness.session.prompt("test");
		await sawFirstCall;
		await harness.session.steer(".");
		releaseTimeout();
		await promptPromise;
		await sawSteeringCall;

		// then
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			"Request timed out.",
		]);
		const secondCall = harness.faux.getCallLog()[1];
		const thirdCall = harness.faux.getCallLog()[2];
		expect(
			secondCall.context.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((content) => content.type === "text")
								.map((content) => content.text)
								.join("\n"),
				),
		).not.toContain(".");
		expect(
			thirdCall.context.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((content) => content.type === "text")
								.map((content) => content.text)
								.join("\n"),
				),
		).toContain(".");
	});

	it("exhausts max retries and emits a failure event", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:false"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("exhausts the retry budget across consecutive aborted transport timeouts", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		let queuedSteering: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedSteering === undefined) {
				queuedSteering = harness.session.steer("retain after retry exhaustion");
			}
		});
		const abortedTimeout = () =>
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request timed out." });
		harness.setResponses([
			abortedTimeout(),
			abortedTimeout(),
			abortedTimeout(),
			fauxAssistantMessage("must not run"),
			fauxAssistantMessage("queued input must not run"),
		]);

		await harness.session.prompt("test");
		await queuedSteering;

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 2, finalError: "Request timed out." },
		]);
		expect(harness.eventsOfType("auto_retry_end").some((event) => event.success)).toBe(false);
		expect(harness.session.getSteeringMessages()).toEqual(["retain after retry exhaustion"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not retry non-retryable errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("suppresses turn retry for a provider-marked rate limit after text and a tool call", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: "partial" }, fauxToolCall("echo", { value: "once" })], {
				stopReason: "error",
				errorMessage: "senpi:no-turn-retry: rate_limit",
			}),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type)).toEqual(
			expect.arrayContaining(["text_delta", "toolcall_delta"]),
		);
		expect(getAssistantTexts(harness)).toEqual(["partial"]);
	});

	it("cancels retry sleep when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("waits for the full loop when retry recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("emits extension events before public event subscribers", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
					pi.on("message_end", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`public:${event.type}:${event.message.role}`);
			}
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(order).toEqual([
			"extension:message_start:user",
			"public:message_start:user",
			"extension:message_end:user",
			"public:message_end:user",
			"extension:message_start:assistant",
			"public:message_start:assistant",
			"extension:message_end:assistant",
			"public:message_end:assistant",
		]);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end for error responses", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
	});

	it("delivers retry_probe_scheduled to a subscribed listener with payload intact", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					hintedWaitCapMs: 8,
					probeBackMaxMs: 3_600_000,
					fallbackChains: { [probePrimary]: [probeFallback] },
				},
			},
		});
		harnesses.push(harness);

		const probeEvents: Array<{ type: string; selector: string; atMs?: number; probeIndex?: number; ok?: boolean }> =
			[];
		harness.session.subscribe((event) => {
			if (event.type === "retry_probe_scheduled") {
				probeEvents.push({
					type: event.type,
					selector: event.selector,
					atMs: event.atMs,
					probeIndex: event.probeIndex,
				});
			}
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: hint1258ms }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		// retry_probe_scheduled must reach the subscriber with exact payload.
		const scheduled = harness.eventsOfType("retry_probe_scheduled");
		expect(scheduled.length).toBeGreaterThanOrEqual(1);
		expect(scheduled[0]).toMatchObject({
			type: "retry_probe_scheduled",
			selector: probePrimary,
			probeIndex: 1,
		});
		expect(typeof scheduled[0].atMs).toBe("number");
		expect(probeEvents.length).toBeGreaterThanOrEqual(1);
		expect(probeEvents[0]).toMatchObject({
			type: "retry_probe_scheduled",
			selector: probePrimary,
			probeIndex: 1,
		});
	});

	it("delivers retry_probe_result to a subscribed listener with payload intact", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					hintedWaitCapMs: 8,
					probeBackMaxMs: 3_600_000,
					fallbackChains: { [probePrimary]: [probeFallback] },
				},
			},
		});
		harnesses.push(harness);

		const sawResult = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "retry_probe_result") {
					unsubscribe();
					resolve();
				}
			});
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: hint1258ms }),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("probe ok"),
		]);

		await harness.session.prompt("hello");
		// Wait for the probe timer to fire and deliver a result event.
		await sawResult;

		const results = harness.eventsOfType("retry_probe_result");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]).toMatchObject({
			type: "retry_probe_result",
			selector: probePrimary,
		});
		expect(typeof results[0].ok).toBe("boolean");
	});

	it("emits agent_end for aborted runs and persists the aborted assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
