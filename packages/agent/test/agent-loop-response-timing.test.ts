import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

let clock = 0;

type Step = readonly [advanceMs: number, event: AssistantMessageEvent];

class ScriptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private readonly steps: readonly Step[];
	private readonly final: AssistantMessage;

	constructor(steps: readonly Step[], final: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		this.steps = steps;
		this.final = final;
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		for (const [advanceMs, event] of this.steps) {
			clock += advanceMs;
			yield event;
		}
	}

	override result(): Promise<AssistantMessage> {
		return Promise.resolve(this.final);
	}
}

class InterruptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private readonly steps: readonly Step[];
	private readonly ending: "hang" | Error;

	constructor(steps: readonly Step[], ending: "hang" | Error) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		this.steps = steps;
		this.ending = ending;
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		for (const [advanceMs, event] of this.steps) {
			clock += advanceMs;
			yield event;
		}
		if (this.ending === "hang") await new Promise<never>(() => {});
		throw this.ending;
	}

	override result(): Promise<AssistantMessage> {
		return this.ending === "hang" ? new Promise<never>(() => {}) : Promise.reject(this.ending);
	}
}

function usage(output: number, reasoning?: number): AssistantMessage["usage"] {
	return {
		input: 10,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10 + output,
		...(reasoning === undefined ? {} : { reasoning }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	content: AssistantMessage["content"],
	output = 0,
	stopReason: AssistantMessage["stopReason"] = "stop",
	reasoning?: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: usage(output, reasoning),
		stopReason,
		timestamp: clock,
	};
}

const model: Model<"openai-responses"> = {
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

const config: AgentLoopConfig = {
	model,
	convertToLlm: (messages: AgentMessage[]) =>
		messages.filter((message): message is Message => message.role === "user" || message.role === "assistant"),
};

async function run(stream: () => EventStream<AssistantMessageEvent, AssistantMessage>) {
	const context: AgentContext = { systemPrompt: "Test", messages: [], tools: [] };
	const events: AgentEvent[] = [];
	const loop = agentLoop([{ role: "user", content: "Hello", timestamp: clock }], context, config, undefined, stream);
	for await (const event of loop) events.push(event);
	const messages = await loop.result();
	const reply = messages.find((message): message is AssistantMessage => message.role === "assistant");
	if (reply === undefined) throw new Error("no assistant message");
	const ended = events.find(
		(event): event is Extract<AgentEvent, { type: "message_end" }> =>
			event.type === "message_end" && event.message.role === "assistant",
	);
	return { reply, endedMessage: ended?.message };
}

describe("agent loop response timing (senpi#3879)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function useClock(start: number): void {
		clock = start;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	}

	it("stamps request, first token, last token, end and generation time on a streamed reply", async () => {
		useClock(1_000);
		const text = (value: string) => assistant([{ type: "text", text: value }]);
		const final = assistant([{ type: "text", text: "Hello there" }], 4);
		const { reply, endedMessage } = await run(
			() =>
				new ScriptedStream(
					[
						[300, { type: "start", partial: text("") }],
						[200, { type: "text_delta", contentIndex: 0, delta: "Hello", partial: text("Hello") }],
						[700, { type: "text_delta", contentIndex: 0, delta: " there", partial: text("Hello there") }],
						[50, { type: "done", reason: "stop", message: final }],
					],
					final,
				),
		);

		expect(reply.timing).toEqual({
			requestedAt: 1_000,
			firstTokenAt: 1_500,
			lastTokenAt: 2_200,
			endedAt: 2_250,
			generationMs: 700,
		});
		expect(endedMessage?.role === "assistant" ? endedMessage.timing : undefined).toEqual(reply.timing);
	});

	it("times a reply that reasoned before its first delta from the response start", async () => {
		useClock(0);
		const partial = assistant([{ type: "text", text: "" }]);
		const final = assistant([{ type: "text", text: "ok" }], 30, "stop", 26);
		const { reply } = await run(
			() =>
				new ScriptedStream(
					[
						[100, { type: "start", partial }],
						[900, { type: "text_delta", contentIndex: 0, delta: "ok", partial: final }],
						[100, { type: "text_delta", contentIndex: 0, delta: "", partial: final }],
						[0, { type: "done", reason: "stop", message: final }],
					],
					final,
				),
		);

		expect(reply.timing?.generationMs).toBe(1_000);
		expect(reply.timing?.firstTokenAt).toBe(1_000);
	});

	it("records no token times or generation time for a reply that never streamed a delta", async () => {
		useClock(5_000);
		const final = assistant([{ type: "text", text: "all at once" }], 3);
		const { reply } = await run(
			() =>
				new ScriptedStream(
					[
						[400, { type: "start", partial: assistant([]) }],
						[0, { type: "done", reason: "stop", message: final }],
					],
					final,
				),
		);

		expect(reply.timing).toEqual({ requestedAt: 5_000, endedAt: 5_400 });
	});

	it("stamps request and end on an aborted reply", async () => {
		useClock(0);
		const text = (value: string) => assistant([{ type: "text", text: value }]);
		const aborted = assistant([{ type: "text", text: "par" }], 0, "aborted");
		const { reply } = await run(
			() =>
				new ScriptedStream(
					[
						[10, { type: "start", partial: text("") }],
						[20, { type: "text_delta", contentIndex: 0, delta: "par", partial: text("par") }],
						[30, { type: "error", reason: "aborted", error: aborted }],
					],
					aborted,
				),
		);

		expect(reply.stopReason).toBe("aborted");
		expect(reply.timing?.requestedAt).toBe(0);
		expect(reply.timing?.firstTokenAt).toBe(30);
		expect(reply.timing?.endedAt).toBe(60);
	});

	it("stamps no timing when the request was never issued", async () => {
		useClock(0);
		const failing: AgentLoopConfig = {
			...config,
			getApiKey: () => {
				throw new Error("no key");
			},
		};
		const context: AgentContext = { systemPrompt: "Test", messages: [], tools: [] };
		const loop = agentLoop(
			[{ role: "user", content: "Hello", timestamp: 0 }],
			context,
			failing,
			undefined,
			() => new ScriptedStream([], assistant([])),
		);
		for await (const _event of loop) {
		}
		const reply = (await loop.result()).find((message) => message.role === "assistant");

		expect(reply?.role).toBe("assistant");
		expect(reply?.role === "assistant" ? reply.stopReason : undefined).toBe("error");
		expect(reply?.role === "assistant" ? reply.timing : "not assistant").toBeUndefined();
	});
	it("times streamed thinking without a reasoning count from its first delta", async () => {
		useClock(0);
		const thinking = (text: string) => assistant([{ type: "thinking", thinking: text }]);
		const final = assistant(
			[
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "ok" },
			],
			12,
		);
		const { reply } = await run(
			() =>
				new ScriptedStream(
					[
						[100, { type: "start", partial: thinking("") }],
						[400, { type: "thinking_start", contentIndex: 0, partial: thinking("") }],
						[0, { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: thinking("plan") }],
						[600, { type: "text_delta", contentIndex: 1, delta: "ok", partial: final }],
						[0, { type: "done", reason: "stop", message: final }],
					],
					final,
				),
		);

		expect(reply.usage.reasoning).toBeUndefined();
		expect(reply.timing?.firstTokenAt).toBe(500);
		expect(reply.timing?.generationMs).toBe(600);
	});

	it("times a thinking block that never streamed, with no reasoning count, from the response start", async () => {
		useClock(0);
		const text = (value: string) => assistant([{ type: "text", text: value }]);
		const final = assistant(
			[
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "ok" },
			],
			12,
		);
		const { reply } = await run(
			() =>
				new ScriptedStream(
					[
						[100, { type: "start", partial: text("") }],
						[900, { type: "text_delta", contentIndex: 1, delta: "o", partial: text("o") }],
						[200, { type: "text_delta", contentIndex: 1, delta: "k", partial: final }],
						[0, { type: "done", reason: "stop", message: final }],
					],
					final,
				),
		);

		expect(reply.usage.reasoning).toBeUndefined();
		expect(reply.timing?.generationMs).toBe(1_100);
	});

	it("times a reply that reports zero reasoning and has no thinking from its first delta", async () => {
		useClock(0);
		const text = (value: string) => assistant([{ type: "text", text: value }]);
		const final = assistant([{ type: "text", text: "ok" }], 8, "stop", 0);
		const { reply } = await run(
			() =>
				new ScriptedStream(
					[
						[100, { type: "start", partial: text("") }],
						[700, { type: "text_delta", contentIndex: 0, delta: "o", partial: text("o") }],
						[300, { type: "text_delta", contentIndex: 0, delta: "k", partial: final }],
						[0, { type: "done", reason: "stop", message: final }],
					],
					final,
				),
		);

		expect(reply.usage.reasoning).toBe(0);
		expect(reply.timing?.generationMs).toBe(300);
	});

	it("stamps a reply whose stream throws after it started (the catch path)", async () => {
		useClock(0);
		const text = (value: string) => assistant([{ type: "text", text: value }]);
		const { reply } = await run(
			() =>
				new InterruptedStream(
					[
						[50, { type: "start", partial: text("") }],
						[150, { type: "text_delta", contentIndex: 0, delta: "par", partial: text("par") }],
					],
					new Error("socket reset"),
				),
		);

		expect(reply.stopReason).toBe("error");
		expect(reply.timing).toMatchObject({ requestedAt: 0, firstTokenAt: 200, lastTokenAt: 200 });
		expect(reply.timing?.endedAt).toBeGreaterThanOrEqual(200);
	});

	it("stamps a reply finalized as a stop after an idle timeout with resolved tool calls", async () => {
		useClock(0);
		const resolvedCall = Object.assign(
			{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} },
			{ [Symbol.for("provider.block.cursorExecResolved")]: true },
		);
		const partial = assistant([resolvedCall]);
		const config2: AgentLoopConfig = { ...config, timeoutMs: 20 };
		const context: AgentContext = { systemPrompt: "Test", messages: [], tools: [] };
		const loop = agentLoop(
			[{ role: "user", content: "Hello", timestamp: 0 }],
			context,
			config2,
			undefined,
			() =>
				new InterruptedStream(
					[
						[10, { type: "start", partial }],
						[30, { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial }],
					],
					"hang",
				),
		);
		for await (const _event of loop) {
		}
		const reply = (await loop.result()).find((message): message is AssistantMessage => message.role === "assistant");

		// Finalized as a stop (not an idle-timeout error), then promoted because it carries tool calls.
		expect(reply?.stopReason).toBe("toolUse");
		expect(reply?.timing).toMatchObject({ requestedAt: 0, firstTokenAt: 40, lastTokenAt: 40 });
	});
});
