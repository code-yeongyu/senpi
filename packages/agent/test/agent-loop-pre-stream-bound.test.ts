import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

/**
 * senpi#3471: the work before a provider request starts streaming (transformContext, getApiKey, the
 * stream function itself) used to run before any bound existed, so a hung step left the turn waiting
 * forever on every surface. The start bound (or, without one, the idle bound) now covers it and ends
 * the turn with a typed provider failure.
 */

class AssistantEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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

const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** A provider stream whose start is held on a promise the test controls and never resolves: no first event, ever. */
class NeverStartingStream extends AssistantEventStream {
	readonly start = Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return { next: () => this.start.promise };
	}
}

async function settledTurn(
	stream: AsyncIterable<AgentEvent> & { result(): Promise<AgentMessage[]> },
	ceilingMs = 2_000,
): Promise<AgentMessage[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				for await (const _event of stream) {
				}
				return await stream.result();
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("the turn never ended")), ceilingMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

const identityConverter = (messages: AgentMessage[]): Message[] => messages as unknown as Message[];

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function context(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

function assistantOf(messages: AgentMessage[]): AssistantMessage | undefined {
	return messages.find((message): message is AssistantMessage => message.role === "assistant");
}

describe("the start bound covers the work before the provider stream (senpi#3471)", () => {
	it("ends the turn with a typed start-timeout failure when getApiKey never resolves", async () => {
		// given
		let streamCalled = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
			getApiKey: () => never<string>(),
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => {
				streamCalled = true;
				return new AssistantEventStream();
			}),
		);

		// then
		const assistant = assistantOf(messages);
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toContain("Provider stream start timed out after 30ms");
		expect(streamCalled).toBe(false);
	});

	it("ends the turn when transformContext never resolves, and aborts the signal it was given", async () => {
		// given
		let transformSignal: AbortSignal | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
			transformContext: (_messages, signal) => {
				transformSignal = signal;
				return never<AgentMessage[]>();
			},
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => new AssistantEventStream()),
		);

		// then
		expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 30ms");
		expect(transformSignal?.aborted).toBe(true);
	});

	it("ends the turn when the stream function itself never returns a stream", async () => {
		// given
		let requestSignal: AbortSignal | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, (_model, _context, options) => {
				requestSignal = options?.signal;
				return never();
			}),
		);

		// then
		expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 30ms");
		expect(requestSignal?.aborted).toBe(true);
	});

	it("falls back to the idle bound when no start bound is set", async () => {
		// given
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			timeoutMs: 30,
			getApiKey: () => never<string>(),
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => new AssistantEventStream()),
		);

		// then
		const assistant = assistantOf(messages);
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toBe("Idle timeout waiting for provider stream after 30ms");
	});

	it("lets a step finish after a caller abort, as before the bound: the provider is still called and the turn reads aborted", async () => {
		// given: the key lookup is still running when the caller aborts, then completes
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const key = Promise.withResolvers<string>();
		let streamCalls = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 10_000,
			timeoutMs: 10_000,
			getApiKey: () => {
				asked.resolve();
				return key.promise;
			},
		};
		const stream = agentLoop(
			[userMessage("Hello")],
			context(),
			config,
			controller.signal,
			(_model, _context, options) => {
				streamCalls += 1;
				const events = new AssistantEventStream();
				options?.signal?.addEventListener("abort", () => events.end(), { once: true });
				if (options?.signal?.aborted) events.end();
				return events;
			},
		);
		const turn = settledTurn(stream);

		// when: the abort is not raced against the step; the step completes and the request goes out aborted
		await asked.promise;
		controller.abort();
		key.resolve("key");

		// then
		expect(assistantOf(await turn)?.stopReason).toBe("aborted");
		expect(streamCalls).toBe(1);
	});

	it("gives a caller-aborted turn whose step never finishes the abort's message, not the bound's timeout text (#3481)", async () => {
		// given
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 40,
			timeoutMs: 10_000,
			getApiKey: () => {
				asked.resolve();
				return never<string>();
			},
		};
		const turn = settledTurn(
			agentLoop([userMessage("Hello")], context(), config, controller.signal, () => new AssistantEventStream()),
		);

		// when
		await asked.promise;
		controller.abort(new Error("Stopped by the user"));

		// then
		const assistant = assistantOf(await turn);
		expect(assistant?.stopReason).toBe("aborted");
		expect(assistant?.errorMessage).toBe("Stopped by the user");
		expect(assistant?.errorMessage).not.toContain("timed out");
	});

	it("ends a caller-aborted turn whose step never finishes at the bound, still as aborted", async () => {
		// given
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 40,
			timeoutMs: 10_000,
			getApiKey: () => {
				asked.resolve();
				return never<string>();
			},
		};
		const turn = settledTurn(
			agentLoop([userMessage("Hello")], context(), config, controller.signal, () => new AssistantEventStream()),
		);

		// when
		await asked.promise;
		controller.abort();

		// then
		expect(assistantOf(await turn)?.stopReason).toBe("aborted");
	});

	it("reports the configured start bound even when a step before the stream used part of it", async () => {
		// given: the key lookup takes a while, then the provider never sends a first event
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 60,
			timeoutMs: 10_000,
			getApiKey: () => new Promise<string>((resolve) => setTimeout(() => resolve("key"), 15)),
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => new NeverStartingStream()),
		);

		// then
		expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 60ms (");
	});

	it("leaves no unhandled rejection when the request is already aborted and the transform rejects", async () => {
		// given
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const controller = new AbortController();
		controller.abort();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 1_000,
			timeoutMs: 10_000,
			transformContext: async (_messages, signal) => {
				signal?.throwIfAborted();
				return _messages;
			},
		};

		try {
			// when
			const messages = await settledTurn(
				agentLoop([userMessage("Hello")], context(), config, controller.signal, () => new AssistantEventStream()),
			);
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			// then
			expect(assistantOf(messages)?.stopReason).toBe("aborted");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("closes a stream that the stream function returns after the bound already ended the turn", async () => {
		// given
		const late = Promise.withResolvers<AssistantEventStream>();
		const closed = Promise.withResolvers<void>();
		class ClosableStream extends AssistantEventStream {
			override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
				return {
					next: () => never<IteratorResult<AssistantMessageEvent>>(),
					return: async () => {
						closed.resolve();
						return { done: true, value: undefined };
					},
				};
			}
		}
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => late.promise),
		);
		late.resolve(new ClosableStream());

		// then
		expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 30ms");
		await closed.promise;
	});

	it("leaves no unhandled rejection when the stream function resolves late to something that is not a stream", async () => {
		// given
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const late = Promise.withResolvers<AssistantEventStream>();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
		};

		try {
			// when
			const messages = await settledTurn(
				agentLoop([userMessage("Hello")], context(), config, undefined, () => late.promise),
			);
			late.resolve({} as AssistantEventStream);
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			// then
			expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 30ms");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
