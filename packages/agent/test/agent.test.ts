import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolUpdateCallback,
	type StreamFn,
	setDefaultStreamFn,
} from "../src/index.ts";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const unusedStreamFunction: StreamFn = () => {
	throw new Error("Unexpected stream call");
};

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function getUserMessageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function getStreamStartTimeoutMs(options: unknown): number | undefined {
	if (!options || typeof options !== "object" || !("streamStartTimeoutMs" in options)) return undefined;
	const value = (options as { streamStartTimeoutMs?: unknown }).streamStartTimeoutMs;
	return typeof value === "number" ? value : undefined;
}

describe("Agent", () => {
	it("marks main agent-loop streams while leaving unmarked invocations auxiliary", async () => {
		const streamKinds: unknown[] = [];
		const streamFn: StreamFn = (_model, _context, options) => {
			streamKinds.push(
				options && typeof options === "object" && "streamKind" in options ? options.streamKind : undefined,
			);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const agent = new Agent({ streamFn });

		await agent.prompt("main turn");
		const auxiliaryStream = await streamFn(agent.state.model, { messages: [] }, {});
		await auxiliaryStream.result();

		expect(streamKinds).toEqual(["main", undefined]);
	});

	it("uses the configured default when a legacy caller omits streamFn", async () => {
		let calls = 0;
		setDefaultStreamFn(() => {
			calls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("fallback");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		try {
			const agent = Reflect.construct(Agent, [{}]) as Agent;
			await agent.prompt("Hello");
			expect(calls).toBe(1);
		} finally {
			setDefaultStreamFn(undefined);
		}
	});

	it("should create an agent instance with default state", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			streamFn: unusedStreamFunction,
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should subscribe to events", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("emits full lifecycle events for thrown run failures", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe("provider exploded");
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("absorbs external lifecycle events after the run ends", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});
		const listener = vi.fn();
		agent.subscribe(listener);

		await agent.prompt("hello");
		listener.mockClear();

		await expect(
			agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId: "late-bridge-call",
				toolName: "bash",
				result: { content: [{ type: "text", text: "late" }], details: {} },
				isError: false,
			}),
		).resolves.toBeUndefined();

		expect(listener).not.toHaveBeenCalled();
		expect(agent.state.pendingToolCalls).toEqual(new Set());
	});

	it("propagates external event listener failures during an active run", async () => {
		const streamStarted = createDeferred();
		const stream = new MockAssistantStream();
		const agent = new Agent({
			streamFn: () => {
				streamStarted.resolve();
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start") throw new Error("listener failed");
		});

		const prompt = agent.prompt("hello");
		await streamStarted.promise;

		await expect(
			agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId: "active-bridge-call",
				toolName: "bash",
				args: {},
			}),
		).rejects.toThrow("listener failed");

		const message = createAssistantMessage("ok");
		stream.push({ type: "done", reason: "stop", message });
		await prompt;
	});

	it("drops external events owned by a finished run while a new run is active", async () => {
		const runAStarted = createDeferred();
		const runBStarted = createDeferred();
		const runAStream = new MockAssistantStream();
		const runBStream = new MockAssistantStream();
		let streamIndex = 0;
		const agent = new Agent({
			streamFn: () => {
				if (streamIndex++ === 0) {
					runAStarted.resolve();
					return runAStream;
				}
				runBStarted.resolve();
				return runBStream;
			},
		});
		const externalEvents: AgentEvent[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				externalEvents.push(event);
			}
		});

		const runA = agent.prompt("run A");
		await runAStarted.promise;
		const runASignal = agent.signal;
		await agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "run-a-call",
			toolName: "bash",
			args: {},
		});
		runAStream.push({ type: "done", reason: "stop", message: createAssistantMessage("run A done") });
		await runA;

		const runB = agent.prompt("run B");
		await runBStarted.promise;
		externalEvents.length = 0;

		await Reflect.apply(agent.emitExternalEvent, agent, [
			{
				type: "tool_execution_end",
				toolCallId: "run-a-call",
				toolName: "bash",
				result: { content: [{ type: "text", text: "late" }], details: {} },
				isError: false,
			},
			runASignal,
		]);

		expect(externalEvents).toEqual([]);
		runBStream.push({ type: "done", reason: "stop", message: createAssistantMessage("run B done") });
		await runB;
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should not process queued steering after an aborted error event with stale message stopReason", async () => {
		let streamCalls = 0;
		let processedQueuedSteering = false;
		const queuedText = "Queued after abort";
		const agent = new Agent({
			streamFn: (_model, context, options) => {
				streamCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userTexts = context.messages.map(getUserMessageText);
					if (userTexts.includes(queuedText)) {
						processedQueuedSteering = true;
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed queued") });
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const promptPromise = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		agent.steer({
			role: "user",
			content: [{ type: "text", text: queuedText }],
			timestamp: Date.now(),
		});

		agent.abort();
		await promptPromise;

		expect(processedQueuedSteering).toBe(false);
		expect(streamCalls).toBe(1);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("aborted");
	});

	it("should ignore tool updates after the tool execution settles", async () => {
		const toolSchema = Type.Object({});
		let delayedUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown) => {
			unhandledRejections.push(error);
		};
		const tool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "delayed_tool",
			label: "Delayed Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				delayedUpdate = onUpdate;
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { status: "running" },
				});
				return {
					content: [{ type: "text", text: "ok" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "delayed_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		process.on("unhandledRejection", onUnhandledRejection);
		try {
			await agent.prompt("run tool");
			const eventCountAfterPrompt = events.length;

			delayedUpdate?.({
				content: [{ type: "text", text: "late" }],
				details: { status: "late" },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
			expect(events).toHaveLength(eventCountAfterPrompt);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("should ignore a settled parallel tool update while another tool is still running", async () => {
		const toolSchema = Type.Object({});
		const slowStarted = createDeferred();
		const settledToolEnded = createDeferred();
		const releaseSlow = createDeferred();
		let settledToolUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const settledTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "settled_tool",
			label: "Settled Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				settledToolUpdate = onUpdate;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const slowTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "slow_tool",
			label: "Slow Tool",
			description: "Keeps the agent run active",
			parameters: toolSchema,
			async execute() {
				slowStarted.resolve();
				await releaseSlow.promise;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [settledTool, slowTool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "settled_tool", arguments: {} },
							{ type: "toolCall", id: "call-2", name: "slow_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				settledToolEnded.resolve();
			}
		});

		const promptPromise = agent.prompt("run tools");
		await Promise.all([slowStarted.promise, settledToolEnded.promise]);
		const eventCountBeforeLateUpdate = events.length;

		settledToolUpdate?.({
			content: [{ type: "text", text: "late" }],
			details: { status: "late" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toHaveLength(eventCountBeforeLateUpdate);

		releaseSlow.resolve();
		await promptPromise;
		expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(0);
	});

	it("should update state with mutators", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Test setSystemPrompt
		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools: AgentTool[] = [
			{
				name: "test",
				label: "Test",
				description: "test tool",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "ok" }],
					details: undefined,
				}),
			},
		];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = createAssistantMessage("Hi");
		agent.state.messages.push(newMessage);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("retains agent_end queues without aborting when drain suppression is requested", async () => {
		let providerCalls = 0;
		let agentEndSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`response ${providerCalls}`),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event, signal) => {
			if (event.type !== "agent_end" || providerCalls !== 1) return;
			agentEndSignal = signal;
			agent.followUp({ role: "user", content: "deferred follow-up", timestamp: Date.now() });
			agent.suppressQueuedMessageDrain();
		});

		await agent.prompt("first prompt");

		expect(agentEndSignal?.aborted).toBe(false);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(providerCalls).toBe(1);

		await agent.continue();

		expect(agent.hasQueuedMessages()).toBe(false);
		expect(providerCalls).toBe(2);
	});

	it("defers queued input only from a continuation's first provider request", async () => {
		const providerUserTexts: string[][] = [];
		const providerTimeouts: Array<{ timeoutMs?: number; streamStartTimeoutMs?: number }> = [];
		const agent = new Agent({
			initialState: {
				messages: [{ role: "user", content: "original request", timestamp: Date.now() }],
			},
			timeoutMs: 300_000,
			streamStartTimeoutMs: 90_000,
			streamFn: (_model, context, options) => {
				providerUserTexts.push(
					context.messages
						.filter((message) => message.role === "user")
						.map((message) => getUserMessageText(message)),
				);
				providerTimeouts.push({
					timeoutMs: options?.timeoutMs,
					streamStartTimeoutMs: getStreamStartTimeoutMs(options),
				});
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("recovered") });
				});
				return stream;
			},
		});
		agent.steer({ role: "user", content: "queued steering", timestamp: Date.now() });

		await agent.continue({
			deferQueuedMessages: true,
			timeoutMs: 30_000,
			streamStartTimeoutMs: 30_000,
		});

		expect(providerUserTexts).toEqual([["original request"], ["original request", "queued steering"]]);
		expect(providerTimeouts).toEqual([
			{ timeoutMs: 30_000, streamStartTimeoutMs: 30_000 },
			{ timeoutMs: 300_000, streamStartTimeoutMs: 90_000 },
		]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("restores configured timeouts after a call-scoped continuation override", async () => {
		const providerTimeouts: Array<{ timeoutMs?: number; streamStartTimeoutMs?: number }> = [];
		const agent = new Agent({
			initialState: {
				messages: [{ role: "user", content: "retry me", timestamp: Date.now() }],
			},
			timeoutMs: 300_000,
			streamStartTimeoutMs: 90_000,
			streamFn: (_model, _context, options) => {
				providerTimeouts.push({
					timeoutMs: options?.timeoutMs,
					streamStartTimeoutMs: getStreamStartTimeoutMs(options),
				});
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		await agent.continue({ timeoutMs: 30_000, streamStartTimeoutMs: 30_000 });
		await agent.prompt("ordinary request");

		expect(providerTimeouts).toEqual([
			{ timeoutMs: 30_000, streamStartTimeoutMs: 30_000 },
			{ timeoutMs: 300_000, streamStartTimeoutMs: 90_000 },
		]);
	});

	it("restores the configured idle timeout after a capped retry stream shows life", async () => {
		vi.useFakeTimers();
		try {
			let providerOptions: { timeoutMs?: number; streamStartTimeoutMs?: number } | undefined;
			const agent = new Agent({
				initialState: {
					messages: [{ role: "user", content: "retry me", timestamp: Date.now() }],
				},
				timeoutMs: 300_000,
				streamStartTimeoutMs: 90_000,
				streamFn: (_model, _context, options) => {
					providerOptions = {
						timeoutMs: options?.timeoutMs,
						streamStartTimeoutMs: getStreamStartTimeoutMs(options),
					};
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						setTimeout(() => {
							stream.push({
								type: "done",
								reason: "stop",
								message: createAssistantMessage("healthy delayed response"),
							});
						}, 40_000);
					});
					return stream;
				},
			});

			const continuation = agent.continue({ timeoutMs: 30_000, streamStartTimeoutMs: 30_000 });
			await vi.advanceTimersByTimeAsync(40_000);
			await continuation;

			expect(providerOptions).toEqual({ timeoutMs: 30_000, streamStartTimeoutMs: 30_000 });
			const lastMessage = agent.state.messages.at(-1);
			if (lastMessage?.role !== "assistant") throw new Error("Expected final assistant response");
			expect(lastMessage.content).toEqual([{ type: "text", text: "healthy delayed response" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["error", "steering"],
		["error", "followUp"],
		["aborted", "steering"],
		["aborted", "followUp"],
	] as const)("parks queued %s-run %s input until a later admitted prompt", async (stopReason, queue) => {
		let providerCalls = 0;
		const providerUserTexts: string[][] = [];
		const queuedMessage: AgentMessage = {
			role: "user",
			content: "retained queued input",
			timestamp: Date.now(),
		};
		const agent = new Agent({
			streamFn: (_model, context) => {
				providerCalls++;
				providerUserTexts.push(
					context.messages
						.filter((message) => message.role === "user")
						.map((message) => getUserMessageText(message)),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCalls === 1) {
						stream.push({
							type: "error",
							reason: stopReason,
							error: {
								...createAssistantMessage(""),
								stopReason,
								errorMessage: `${stopReason} provider response`,
							},
						});
						return;
					}
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("recovered") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type !== "agent_end" || providerCalls !== 1) return;
			if (queue === "steering") agent.steer(queuedMessage);
			else agent.followUp(queuedMessage);
		});

		await agent.prompt("initial request");

		expect(agent.hasQueuedMessages()).toBe(true);
		expect(providerCalls).toBe(1);
		expect(agent.state.messages).not.toContain(queuedMessage);

		await agent.prompt("later admitted prompt");

		expect(providerUserTexts).toEqual(
			queue === "steering"
				? [["initial request"], ["initial request", "later admitted prompt", "retained queued input"]]
				: [
						["initial request"],
						["initial request", "later admitted prompt"],
						["initial request", "later admitted prompt", "retained queued input"],
					],
		);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("should reject reset while processing without corrupting the transcript", async () => {
		const streamStarted = createDeferred();
		const releaseResponse = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(async () => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					streamStarted.resolve();
					await releaseResponse.promise;
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const promptPromise = agent.prompt("Hello");
		await streamStarted.promise;

		try {
			expect(agent.state.isStreaming).toBe(true);
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
			expect(() => agent.reset()).toThrow("Agent is already processing. Wait for completion before resetting.");
			expect(agent.state.isStreaming).toBe(true);
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
		} finally {
			releaseResponse.resolve();
			await promptPromise;
		}

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("keeps legacy prepareNextTurn signal callback behavior", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareNextTurn: async (signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				return undefined;
			},
			streamFn: () => {
				requestCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (requestCount === 1) {
						const message = createAssistantToolUseMessage([
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(2);
		expect(sawAbortSignal).toBe(true);
	});

	it.each(["steering", "followUp"] as const)(
		"retains queued %s input when next-turn preparation fails after a terminating tool",
		async (queue) => {
			// given
			const toolStarted = createDeferred();
			const releaseTool = createDeferred();
			const schema = Type.Object({});
			const tool: AgentTool<typeof schema> = {
				name: "terminating",
				label: "Terminating",
				description: "Terminates after release",
				parameters: schema,
				execute: async () => {
					toolStarted.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
				},
			};
			let requestCount = 0;
			const agent = new Agent({
				initialState: { tools: [tool] },
				prepareNextTurnWithContext: async () => {
					throw new Error("required preparation failed");
				},
				streamFn: () => {
					requestCount++;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantToolUseMessage([
								{ type: "toolCall", id: "tool-1", name: "terminating", arguments: {} },
							]),
						});
					});
					return stream;
				},
			});
			const queuedMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "queued safety instruction" }],
				timestamp: Date.now(),
			};

			// when
			const prompt = agent.prompt("run the terminating tool");
			await toolStarted.promise;
			if (queue === "steering") {
				agent.steer(queuedMessage);
			} else {
				agent.followUp(queuedMessage);
			}
			releaseTool.resolve();
			await prompt;

			// then
			expect(requestCount).toBe(1);
			expect(agent.hasQueuedMessages()).toBe(true);
			expect(agent.state.messages).not.toContain(queuedMessage);
			expect(agent.state.errorMessage).toContain("required preparation failed");
		},
	);

	it.each(["steering", "followUp"] as const)(
		"retains queued %s input when next-turn preparation aborts after a terminating tool",
		async (queue) => {
			// given
			const toolStarted = createDeferred();
			const releaseTool = createDeferred();
			const schema = Type.Object({});
			const tool: AgentTool<typeof schema> = {
				name: "terminating",
				label: "Terminating",
				description: "Terminates after release",
				parameters: schema,
				execute: async () => {
					toolStarted.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
				},
			};
			let providerCalls = 0;
			let agent: Agent;
			agent = new Agent({
				initialState: { tools: [tool] },
				prepareNextTurnWithContext: async () => {
					agent.abort();
					return undefined;
				},
				streamFn: () => {
					providerCalls++;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantToolUseMessage([
								{ type: "toolCall", id: "tool-1", name: "terminating", arguments: {} },
							]),
						});
					});
					return stream;
				},
			});
			const queuedMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "queued safety instruction" }],
				timestamp: Date.now(),
			};

			// when
			const prompt = agent.prompt("run the terminating tool");
			await toolStarted.promise;
			if (queue === "steering") {
				agent.steer(queuedMessage);
			} else {
				agent.followUp(queuedMessage);
			}
			releaseTool.resolve();
			await prompt;

			// then
			expect(providerCalls).toBe(1);
			expect(agent.hasQueuedMessages()).toBe(true);
			expect(agent.state.messages).not.toContain(queuedMessage);
			expect(agent.state.errorMessage).toBeUndefined();
		},
	);

	it.each(["steering", "followUp"] as const)(
		"clears queued %s input when next-turn preparation clears it before aborting",
		async (queue) => {
			// given
			const toolStarted = createDeferred();
			const releaseTool = createDeferred();
			const schema = Type.Object({});
			const tool: AgentTool<typeof schema> = {
				name: "terminating",
				label: "Terminating",
				description: "Terminates after release",
				parameters: schema,
				execute: async () => {
					toolStarted.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
				},
			};
			let providerCalls = 0;
			let agent: Agent;
			agent = new Agent({
				initialState: { tools: [tool] },
				prepareNextTurnWithContext: async () => {
					if (queue === "steering") {
						agent.clearSteeringQueue();
					} else {
						agent.clearFollowUpQueue();
					}
					agent.abort();
					return undefined;
				},
				streamFn: () => {
					providerCalls++;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantToolUseMessage([
								{ type: "toolCall", id: "tool-1", name: "terminating", arguments: {} },
							]),
						});
					});
					return stream;
				},
			});
			const queuedMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "queued safety instruction" }],
				timestamp: Date.now(),
			};

			// when
			const prompt = agent.prompt("run the terminating tool");
			await toolStarted.promise;
			if (queue === "steering") {
				agent.steer(queuedMessage);
			} else {
				agent.followUp(queuedMessage);
			}
			releaseTool.resolve();
			await prompt;

			// then
			expect(providerCalls).toBe(1);
			expect(agent.hasQueuedMessages()).toBe(false);
			expect(agent.state.messages).not.toContain(queuedMessage);
			expect(agent.state.errorMessage).toBeUndefined();
		},
	);

	it.each([
		["steering", false],
		["steering", true],
		["followUp", false],
		["followUp", true],
	] as const)(
		"does not deliver cleared %s input after successful next-turn preparation (replacement: %s)",
		async (queue, withReplacement) => {
			// given
			const toolStarted = createDeferred();
			const releaseTool = createDeferred();
			const schema = Type.Object({});
			const tool: AgentTool<typeof schema> = {
				name: "terminating",
				label: "Terminating",
				description: "Terminates after release",
				parameters: schema,
				execute: async () => {
					toolStarted.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
				},
			};
			let providerCalls = 0;
			const providerUserTexts: string[][] = [];
			let preparedTerminatingTurn = false;
			const replacementMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "replacement instruction" }],
				timestamp: Date.now(),
			};
			let agent: Agent;
			agent = new Agent({
				initialState: { tools: [tool] },
				prepareNextTurnWithContext: async () => {
					if (preparedTerminatingTurn) return undefined;
					preparedTerminatingTurn = true;
					if (queue === "steering") {
						agent.clearSteeringQueue();
						if (withReplacement) agent.steer(replacementMessage);
					} else {
						agent.clearFollowUpQueue();
						if (withReplacement) agent.followUp(replacementMessage);
					}
					return undefined;
				},
				streamFn: (_model, context) => {
					providerCalls++;
					providerUserTexts.push(
						context.messages
							.filter((message) => message.role === "user")
							.map((message) =>
								typeof message.content === "string"
									? message.content
									: message.content
											.filter((content) => content.type === "text")
											.map((content) => content.text)
											.join("\n"),
							),
					);
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						if (providerCalls === 1) {
							stream.push({
								type: "done",
								reason: "toolUse",
								message: createAssistantToolUseMessage([
									{ type: "toolCall", id: "tool-1", name: "terminating", arguments: {} },
								]),
							});
							return;
						}
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
					});
					return stream;
				},
			});
			const withdrawnMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "withdrawn safety instruction" }],
				timestamp: Date.now(),
			};

			// when
			const prompt = agent.prompt("run the terminating tool");
			await toolStarted.promise;
			if (queue === "steering") {
				agent.steer(withdrawnMessage);
			} else {
				agent.followUp(withdrawnMessage);
			}
			releaseTool.resolve();
			await prompt;

			// then
			expect(providerCalls).toBe(withReplacement ? 2 : 1);
			expect(providerUserTexts.flat()).not.toContain("withdrawn safety instruction");
			expect(agent.state.messages).not.toContain(withdrawnMessage);
			if (withReplacement) {
				expect(providerUserTexts.flat()).toEqual([
					"run the terminating tool",
					"run the terminating tool",
					"replacement instruction",
				]);
			}
		},
	);

	it("delivers steering queued during terminating-turn preparation before an older follow-up", async () => {
		// given
		const toolStarted = createDeferred();
		const releaseTool = createDeferred();
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "terminating",
			label: "Terminating",
			description: "Terminates after release",
			parameters: schema,
			execute: async () => {
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
			},
		};
		let providerCalls = 0;
		const providerUserTexts: string[][] = [];
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareNextTurnWithContext: async () => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return undefined;
			},
			streamFn: (_model, context) => {
				providerCalls++;
				providerUserTexts.push(
					context.messages
						.filter((message) => message.role === "user")
						.flatMap((message) =>
							typeof message.content === "string"
								? [message.content]
								: message.content.filter((content) => content.type === "text").map((content) => content.text),
						),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCalls === 1) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantToolUseMessage([
								{ type: "toolCall", id: "tool-1", name: "terminating", arguments: {} },
							]),
						});
						return;
					}
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		// when
		const prompt = agent.prompt("start");
		await toolStarted.promise;
		agent.followUp({ role: "user", content: [{ type: "text", text: "old follow-up" }], timestamp: Date.now() });
		releaseTool.resolve();
		await preparationStarted.promise;
		agent.steer({ role: "user", content: [{ type: "text", text: "urgent steering" }], timestamp: Date.now() });
		releasePreparation.resolve();
		await prompt;

		// then
		expect(providerCalls).toBe(3);
		expect(providerUserTexts[1]).toEqual(["start", "urgent steering"]);
		expect(providerUserTexts[2]).toEqual(["start", "urgent steering", "old follow-up"]);
	});

	it.each([
		["steering", false],
		["steering", true],
		["followUp", false],
		["followUp", true],
	] as const)(
		"honors %s clear during terminating continuation turn_start (replacement: %s)",
		async (queue, replace) => {
			// given
			const toolStarted = createDeferred();
			const releaseTool = createDeferred();
			const schema = Type.Object({});
			const tool: AgentTool<typeof schema> = {
				name: "terminating",
				label: "Terminating",
				description: "Terminates after release",
				parameters: schema,
				execute: async () => {
					toolStarted.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
				},
			};
			let providerCalls = 0;
			const providerUserTexts: string[][] = [];
			const agent = new Agent({
				initialState: { tools: [tool] },
				prepareNextTurnWithContext: async () => undefined,
				streamFn: (_model, context) => {
					providerCalls++;
					providerUserTexts.push(
						context.messages
							.filter((message) => message.role === "user")
							.flatMap((message) =>
								typeof message.content === "string"
									? [message.content]
									: message.content
											.filter((content) => content.type === "text")
											.map((content) => content.text),
							),
					);
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						if (providerCalls === 1) {
							stream.push({
								type: "done",
								reason: "toolUse",
								message: createAssistantToolUseMessage([
									{ type: "toolCall", id: "tool-1", name: "terminating", arguments: {} },
								]),
							});
							return;
						}
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
					});
					return stream;
				},
			});
			let turnStarts = 0;
			agent.subscribe((event) => {
				if (event.type !== "turn_start" || ++turnStarts !== 2) return;
				if (queue === "steering") {
					agent.clearSteeringQueue();
					if (replace) {
						agent.steer({
							role: "user",
							content: [{ type: "text", text: "replacement" }],
							timestamp: Date.now(),
						});
					}
				} else {
					agent.clearFollowUpQueue();
					if (replace) {
						agent.followUp({
							role: "user",
							content: [{ type: "text", text: "replacement" }],
							timestamp: Date.now(),
						});
					}
				}
			});

			// when
			const prompt = agent.prompt("start");
			await toolStarted.promise;
			const withdrawn = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "withdrawn" }],
				timestamp: Date.now(),
			};
			if (queue === "steering") agent.steer(withdrawn);
			else agent.followUp(withdrawn);
			releaseTool.resolve();
			await prompt;

			// then
			expect(providerCalls).toBe(replace ? 2 : 1);
			expect(providerUserTexts.flat()).not.toContain("withdrawn");
			if (replace) expect(providerUserTexts[1]).toEqual(["start", "replacement"]);
		},
	);

	it("forwards shouldStopAfterTurn through AgentOptions", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "tool complete" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		let callbackContextRoles: string[] = [];
		const agent = new Agent({
			initialState: { tools: [tool] },
			shouldStopAfterTurn: (context, signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				callbackContextRoles = context.context.messages.map((message) => message.role);
				return true;
			},
			streamFn: () => {
				requestCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (requestCount === 1) {
						const message = createAssistantToolUseMessage([
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = createAssistantMessage("should not run");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(1);
		expect(sawAbortSignal).toBe(true);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
	});

	it("forwards sessionId to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});
});
