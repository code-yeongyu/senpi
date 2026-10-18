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

	it("carries a caller's non-Error abort reason as the message (#3510)", async () => {
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
		controller.abort("user stop");

		// then
		const assistant = assistantOf(await turn);
		expect(assistant?.stopReason).toBe("aborted");
		expect(assistant?.errorMessage).toBe("user stop");
	});

	it.each([
		["a plain string", "user stop", "user stop"],
		["an Error", new Error("Stopped by the user"), "Stopped by the user"],
		["an Error with a long message, kept whole as before", new Error("e".repeat(600)), "e".repeat(600)],
		["an object with a message", { message: "stopped from the client" }, "stopped from the client"],
		["undefined (a bare abort)", undefined, "This operation was aborted"],
		["a number", 42, "Request was aborted"],
		["an object without a message", { code: 1 }, "Request was aborted"],
		["an empty string", "", "Request was aborted"],
		["a whitespace-only string", "   ", "Request was aborted"],
	] as const)(
		"keeps the caller's reason for %s on a caller-aborted turn (#3510)",
		async (_shape, reason, expected) => {
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
			if (reason === undefined) controller.abort();
			else controller.abort(reason);

			// then
			const assistant = assistantOf(await turn);
			expect(assistant?.stopReason).toBe("aborted");
			expect(assistant?.errorMessage).toBe(expected);
		},
	);

	it("bounds a long string abort reason in the message (#3510)", async () => {
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
		controller.abort("x".repeat(5000));

		// then
		const message = assistantOf(await turn)?.errorMessage ?? "";
		expect(message.length).toBe(501);
		expect(message.endsWith("\u2026")).toBe(true);
	});

	it("caps a long reason on whole characters, never splitting an emoji (#3510)", async () => {
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
		controller.abort(`${"x".repeat(499)}\u{1F600}tail`);

		// then
		const message = assistantOf(await turn)?.errorMessage ?? "";
		expect(message.isWellFormed()).toBe(true);
		expect(message).toBe(`${"x".repeat(499)}\u{1F600}\u2026`);
	});

	it.each([
		["a long string", "y".repeat(5000), `${"y".repeat(500)}\u2026`],
		["an object with a message", { message: "stopped from the client" }, "stopped from the client"],
	] as const)("shapes %s rethrown by a step through the same rules (#3510)", async (_shape, reason, expected) => {
		// given: a context transform that rethrows the caller's own reason once aborted
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 10_000,
			timeoutMs: 10_000,
			transformContext: async (messages, signal) => {
				asked.resolve();
				await release.promise;
				signal?.throwIfAborted();
				return messages;
			},
		};
		const turn = settledTurn(
			agentLoop([userMessage("Hello")], context(), config, controller.signal, () => new AssistantEventStream()),
		);

		// when
		await asked.promise;
		controller.abort(reason);
		release.resolve();

		// then
		const assistant = assistantOf(await turn);
		expect(assistant?.stopReason).toBe("aborted");
		expect(assistant?.errorMessage).toBe(expected);
	});

	it("keeps a step's own thrown value when it is not the caller's reason (#3510)", async () => {
		// given: the step throws its own string after the caller aborted with a different reason
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 10_000,
			timeoutMs: 10_000,
			transformContext: async () => {
				asked.resolve();
				await release.promise;
				throw "transform failed";
			},
		};
		const turn = settledTurn(
			agentLoop([userMessage("Hello")], context(), config, controller.signal, () => new AssistantEventStream()),
		);

		// when
		await asked.promise;
		controller.abort("user stop");
		release.resolve();

		// then
		expect(assistantOf(await turn)?.errorMessage).toBe("transform failed");
	});

	it("keeps the step's own error on a caller-aborted turn that fails for another reason (#3510)", async () => {
		// given: the key lookup is running when the caller aborts, then fails on its own
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const key = Promise.withResolvers<string>();
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
		const turn = settledTurn(
			agentLoop([userMessage("Hello")], context(), config, controller.signal, () => new AssistantEventStream()),
		);

		// when
		await asked.promise;
		controller.abort(new Error("Stopped by the user"));
		key.reject(new Error("key service answered 500"));

		// then: only the bound's own timeout is replaced by the abort; any other error is kept
		const assistant = assistantOf(await turn);
		expect(assistant?.stopReason).toBe("aborted");
		expect(assistant?.errorMessage).toBe("key service answered 500");
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
