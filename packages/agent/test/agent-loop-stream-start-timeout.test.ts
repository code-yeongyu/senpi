import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop, StreamStartTimeoutError } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

/**
 * Regression coverage for the stream-start bound.
 *
 * A dead upstream can accept a request and never send a first byte. Providers
 * only push the "start" event once the HTTP response begins, so before this
 * bound existed the only protection was the idle timeout (default 300s) — a
 * stuck session froze for 5 minutes per attempt with zero persisted output.
 * (Reported via a donated 5h session log: 4 failures, all usage=0.)
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

class NeverStartingStream extends AssistantEventStream {
	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		await new Promise<never>(() => {});
	}
}

class StartThenHangStream extends AssistantEventStream {
	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		yield { type: "start", partial: createAssistantMessage([{ type: "text", text: "partial answer" }]) };
		await new Promise<never>(() => {});
	}
}

class SlowButAliveStream extends AssistantEventStream {
	private readonly gapMs: number;

	constructor(gapMs: number) {
		super();
		this.gapMs = gapMs;
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const partial = createAssistantMessage([{ type: "text", text: "answer" }]);
		yield { type: "start", partial };
		await new Promise((resolve) => setTimeout(resolve, this.gapMs));
		yield { type: "text_delta", contentIndex: 0, delta: "answer", partial };
		await new Promise((resolve) => setTimeout(resolve, this.gapMs));
		yield { type: "done", reason: "stop", message: partial };
	}

	override result(): Promise<AssistantMessage> {
		return Promise.resolve(createAssistantMessage([{ type: "text", text: "answer" }]));
	}
}

async function collectAgentEvents(
	stream: AsyncIterable<AgentEvent> & { result(): Promise<AgentMessage[]> },
	timeoutMs = 500,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	const events: AgentEvent[] = [];
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				for await (const event of stream) {
					events.push(event);
				}
				return { events, messages: await stream.result() };
			})(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("agentLoop stream did not terminate")), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const identityConverter = (messages: AgentMessage[]): Message[] => messages as unknown as Message[];

function createContext(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

function findAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	return messages.find((message): message is AssistantMessage => message.role === "assistant");
}

describe("agent loop stream-start timeout", () => {
	it("names the setting that controls the stream-start timeout", () => {
		expect(new StreamStartTimeoutError(123).message).toContain("retry.provider.streamStartTimeoutMs");
	});
	it("fails fast when the provider stream never emits a first event", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 20,
			timeoutMs: 10_000,
		};

		let requestSignal: AbortSignal | undefined;
		const stream = agentLoop([createUserMessage("Hello")], createContext(), config, undefined, (_m, _c, options) => {
			requestSignal = options?.signal;
			return new NeverStartingStream();
		});

		const { messages } = await collectAgentEvents(stream);
		const assistantMessage = findAssistant(messages);
		expect(assistantMessage?.stopReason).toBe("error");
		expect(assistantMessage?.errorMessage).toContain("Provider stream start timed out after 20ms");
		expect(assistantMessage?.errorMessage).toContain("retry.provider.streamStartTimeoutMs");
		expect(requestSignal?.aborted).toBe(true);
		expect(String(requestSignal?.reason)).toContain("Provider stream start timed out after 20ms");
	});

	it("stops applying the start bound once the first event arrived", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 20,
			timeoutMs: 60,
		};

		const stream = agentLoop([createUserMessage("Hello")], createContext(), config, undefined, () => {
			return new StartThenHangStream();
		});

		const { messages } = await collectAgentEvents(stream);
		const assistantMessage = findAssistant(messages);
		expect(assistantMessage?.stopReason).toBe("error");
		expect(assistantMessage?.errorMessage).toBe("Idle timeout waiting for provider stream after 60ms");
	});

	it("lets slow-but-alive streams finish despite gaps above the start bound", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 20,
			timeoutMs: 200,
		};

		const stream = agentLoop([createUserMessage("Hello")], createContext(), config, undefined, () => {
			return new SlowButAliveStream(40);
		});

		const { messages } = await collectAgentEvents(stream);
		const assistantMessage = findAssistant(messages);
		expect(assistantMessage?.stopReason).toBe("stop");
		expect(assistantMessage?.errorMessage).toBeUndefined();
	});

	it("keeps today's idle-only behavior when streamStartTimeoutMs is unset", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			timeoutMs: 20,
		};

		const stream = agentLoop([createUserMessage("Hello")], createContext(), config, undefined, () => {
			return new NeverStartingStream();
		});

		const { messages } = await collectAgentEvents(stream);
		const assistantMessage = findAssistant(messages);
		expect(assistantMessage?.stopReason).toBe("error");
		expect(assistantMessage?.errorMessage).toBe("Idle timeout waiting for provider stream after 20ms");
	});

	it("ignores non-positive start bounds", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 0,
			timeoutMs: 20,
		};

		const stream = agentLoop([createUserMessage("Hello")], createContext(), config, undefined, () => {
			return new NeverStartingStream();
		});

		const { messages } = await collectAgentEvents(stream);
		const assistantMessage = findAssistant(messages);
		expect(assistantMessage?.stopReason).toBe("error");
		expect(assistantMessage?.errorMessage).toBe("Idle timeout waiting for provider stream after 20ms");
	});
});
